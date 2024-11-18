import {
  Auction,
  AuctionType,
  FixedMath,
  Request,
  RequestType,
  ScaledAuction,
} from '@blend-capital/blend-sdk';
import { getFillerAvailableBalances, getFillerProfitPct } from './filler.js';
import { APP_CONFIG, Filler } from './utils/config.js';
import { AuctioneerDatabase } from './utils/db.js';
import { logger } from './utils/logger.js';
import { SorobanHelper } from './utils/soroban_helper.js';

export interface FillCalculation {
  // The block number to fill the auction at
  fillBlock: number;
  // The percent of the auction to fill
  fillPercent: number;
}

export interface AuctionFill {
  // The block number to fill the auction at
  block: number;
  // The percent of the auction to fill
  percent: number;
  // The expected lot value paid by the filler
  lotValue: number;
  // The expected bid value the filler will receive
  bidValue: number;
  // The requests to fill the auction
  requests: Request[];
}

export interface AuctionValue {
  effectiveCollateral: number;
  effectiveLiabilities: number;
  repayableLiabilities: number;
  lotValue: number;
  bidValue: number;
}

export async function calculateAuctionFill(
  filler: Filler,
  auction: Auction,
  nextLedger: number,
  sorobanHelper: SorobanHelper,
  db: AuctioneerDatabase
): Promise<AuctionFill> {
  try {
    const relevant_assets = [];
    switch (auction.type) {
      case AuctionType.Liquidation:
        relevant_assets.push(...Array.from(auction.data.lot.keys()));
        relevant_assets.push(...Array.from(auction.data.bid.keys()));
        break;
      case AuctionType.Interest:
        relevant_assets.push(APP_CONFIG.backstopTokenAddress);
        break;
      case AuctionType.BadDebt:
        relevant_assets.push(...Array.from(auction.data.lot.keys()));
        relevant_assets.push(APP_CONFIG.backstopTokenAddress);
        break;
    }
    const fillerBalances = await getFillerAvailableBalances(
      filler,
      [...new Set(relevant_assets)],
      sorobanHelper
    );

    const auctionValue = await calculateAuctionValue(auction, fillerBalances, sorobanHelper, db);
    const { fillBlock, fillPercent } = await calculateBlockFillAndPercent(
      filler,
      auction,
      auctionValue,
      nextLedger,
      sorobanHelper
    );
    const [scaledAuction] = auction.scale(fillBlock, fillPercent);
    const requests = buildFillRequests(scaledAuction, fillPercent, fillerBalances);
    // estimate the lot value and bid value on the fill block
    const blockDelay = fillBlock - auction.data.block;
    const bidScalar = blockDelay <= 200 ? 1 : 1 - Math.max(0, blockDelay - 200) / 200;
    const lotScalar = blockDelay < 200 ? blockDelay / 200 : 1;
    const fillCalcLotValue = auctionValue.lotValue * lotScalar * (fillPercent / 100);
    const fillCalcBidValue = auctionValue.bidValue * bidScalar * (fillPercent / 100);
    return {
      block: fillBlock,
      percent: fillPercent,
      lotValue: fillCalcLotValue,
      bidValue: fillCalcBidValue,
      requests,
    };
  } catch (e: any) {
    logger.error(`Error calculating auction fill.`, e);
    throw e;
  }
}

/**
 * Calculate the block fill and fill percent for a given auction.
 *
 * @param filler - The filler to calculate the block fill for
 * @param auction - The auction to calculate the fill for
 * @param auctionValue - The calculate value of the base auction
 * @param nextLedger - The next ledger number
 * @param sorobanHelper - The soroban helper to use for the calculation
 */
export async function calculateBlockFillAndPercent(
  filler: Filler,
  auction: Auction,
  auctionValue: AuctionValue,
  nextLedger: number,
  sorobanHelper: SorobanHelper
): Promise<FillCalculation> {
  // auction value at block 200, or the base auction, with current prices
  let fillBlockDelay = 0;
  let fillPercent = 100;

  let { effectiveCollateral, effectiveLiabilities, repayableLiabilities, lotValue, bidValue } =
    auctionValue;

  // find the block delay where the auction meets the required profit percentage
  const profitPercent = getFillerProfitPct(filler, APP_CONFIG.profits ?? [], auction.data);
  if (lotValue >= bidValue * (1 + profitPercent)) {
    const minLotAmount = bidValue * (1 + profitPercent);
    fillBlockDelay = 200 - (lotValue - minLotAmount) / (lotValue / 200);
  } else {
    const maxBidAmount = lotValue * (1 - profitPercent);
    fillBlockDelay = 200 + (bidValue - maxBidAmount) / (bidValue / 200);
  }
  fillBlockDelay = Math.min(Math.max(Math.ceil(fillBlockDelay), 0), 400);
  // apply force fill auction boundries to profit calculations
  if (auction.type === AuctionType.Liquidation && filler.forceFill) {
    fillBlockDelay = Math.min(fillBlockDelay, 198);
  } else if (auction.type === AuctionType.Interest && filler.forceFill) {
    fillBlockDelay = Math.min(fillBlockDelay, 350);
  }
  // if calculated fillBlock has already passed, adjust fillBlock to the next ledger
  if (auction.data.block + fillBlockDelay < nextLedger) {
    fillBlockDelay = Math.min(nextLedger - auction.data.block, 400);
  }

  const bidScalarAtFill = fillBlockDelay <= 200 ? 1 : 1 - Math.max(0, fillBlockDelay - 200) / 200;
  const lotScalarAtFill = fillBlockDelay < 200 ? fillBlockDelay / 200 : 1;

  // require that the filler can fully fill interest auctions
  if (auction.type === AuctionType.Interest) {
    const cometLpTokenBalance = FixedMath.toFloat(
      await sorobanHelper.simBalance(APP_CONFIG.backstopTokenAddress, filler.keypair.publicKey()),
      7
    );
    const cometLpBidBase = FixedMath.toFloat(
      auction.data.bid.get(APP_CONFIG.backstopTokenAddress) ?? 0n,
      7
    );
    const cometLpBid = cometLpBidBase * bidScalarAtFill;
    if (cometLpBid > cometLpTokenBalance) {
      const additionalCometLp = cometLpBid - cometLpTokenBalance;
      const bidStepSize = cometLpBidBase / 200;
      if (additionalCometLp >= 0 && bidStepSize > 0) {
        const additionalDelay = Math.ceil(additionalCometLp / bidStepSize);
        fillBlockDelay = Math.max(200, fillBlockDelay) + additionalDelay;
        fillBlockDelay = Math.min(fillBlockDelay, 400);
      }
    }
  } else if (auction.type === AuctionType.Liquidation || auction.type === AuctionType.BadDebt) {
    // require that filler meets minimum health factor requirements
    const { estimate: fillerPositionEstimates } = await sorobanHelper.loadUserPositionEstimate(
      filler.keypair.publicKey()
    );
    // inflate minHealthFactor slightly, to allow for the unwind logic to unwind looped positions safely
    const safeHealthFactor = filler.minHealthFactor * 1.1;
    const additionalLiabilities = effectiveLiabilities * bidScalarAtFill - repayableLiabilities;
    const additionalCollateral = effectiveCollateral * lotScalarAtFill;
    const additionalCollateralReq = additionalLiabilities * safeHealthFactor;
    if (additionalCollateral < additionalCollateralReq) {
      const excessLiabilities = additionalCollateralReq - additionalCollateral;
      const liabilityLimitToHF =
        fillerPositionEstimates.totalEffectiveCollateral / safeHealthFactor -
        fillerPositionEstimates.totalEffectiveLiabilities;

      logger.info(
        `Auction does not add enough collateral to maintain health factor. Additional Collateral: ${additionalCollateral}, Additional Liabilities: ${additionalLiabilities}, Repaid Liabilities: ${repayableLiabilities}, Excess Liabilities to HF: ${excessLiabilities}, Liability Limit to HF: ${liabilityLimitToHF}`
      );

      if (liabilityLimitToHF <= 0) {
        // filler can't take on additional liabilities. Push back fill block until more collateral
        // is received than liabilities taken on, or no liabilities are taken on
        const liabilityBlockDecrease =
          Math.ceil(100 * (excessLiabilities / effectiveLiabilities)) / 0.5;
        fillBlockDelay = Math.min(Math.max(200, fillBlockDelay) + liabilityBlockDecrease, 400);
        logger.info(
          `Unable to fill auction at expected profit due to insufficient collateral, pushing fill block an extra ${liabilityBlockDecrease} back to ${fillBlockDelay}`
        );
      } else if (excessLiabilities > liabilityLimitToHF) {
        // reduce fill percent to the point where the filler can take on the liabilities
        fillPercent = Math.floor((liabilityLimitToHF / excessLiabilities) * 100);
      }
    }
  }
  return { fillBlock: auction.data.block + fillBlockDelay, fillPercent };
}

/**
 * Build requests to fill the auction and repay the liabilities.
 * @param scaledAuction - The scaled auction to build the fill requests for
 * @param fillPercent - The percent to fill the auction
 * @param sorobanHelper - The soroban helper to use for the calculation
 * @returns
 */
export function buildFillRequests(
  scaledAuction: ScaledAuction,
  fillPercent: number,
  fillerBalances: Map<string, bigint>
): Request[] {
  let fillRequests: Request[] = [];
  let requestType: RequestType;
  switch (scaledAuction.type) {
    case AuctionType.Liquidation:
      requestType = RequestType.FillUserLiquidationAuction;
      break;
    case AuctionType.Interest:
      requestType = RequestType.FillInterestAuction;
      break;
    case AuctionType.BadDebt:
      requestType = RequestType.FillBadDebtAuction;
      break;
  }
  fillRequests.push({
    request_type: requestType,
    address: scaledAuction.user,
    amount: BigInt(fillPercent),
  });

  if (scaledAuction.type === AuctionType.Interest) {
    return fillRequests;
  }

  // attempt to repay any liabilities the filler has took on from the bids
  // if this fails for some reason, still continue with the fill
  for (const [assetId] of scaledAuction.data.bid) {
    const fillerBalance = fillerBalances.get(assetId) ?? 0n;
    if (fillerBalance > 0n) {
      fillRequests.push({
        request_type: RequestType.Repay,
        address: assetId,
        amount: BigInt(fillerBalance),
      });
    }
  }
  return fillRequests;
}

/**
 * Calculate the effective collateral, lot value, effective liabilities, and bid value for an auction.
 *
 * @param auction - The auction to calculate the values for
 * @param fillerBalances - The balances of the filler
 * @param sorobanHelper - A helper to use for loading ledger data
 * @param db - The database to use for fetching asset prices
 * @returns The calculated values, or 0 for all values if it is unable to calculate them
 */
export async function calculateAuctionValue(
  auction: Auction,
  fillerBalances: Map<string, bigint>,
  sorobanHelper: SorobanHelper,
  db: AuctioneerDatabase
): Promise<AuctionValue> {
  let effectiveCollateral = 0;
  let lotValue = 0;
  let effectiveLiabilities = 0;
  let repayableLiabilities = 0;
  let bidValue = 0;
  const pool = await sorobanHelper.loadPool();
  const poolOracle = await sorobanHelper.loadPoolOracle();
  const reserves = pool.reserves;
  for (const [assetId, amount] of auction.data.lot) {
    if (auction.type === AuctionType.Liquidation || auction.type === AuctionType.Interest) {
      const reserve = reserves.get(assetId);
      if (reserve === undefined) {
        throw new Error(`Unexpected auction. Lot contains asset that is not a reserve: ${assetId}`);
      }
      const oraclePrice = poolOracle.getPriceFloat(assetId);
      const dbPrice = db.getPriceEntry(assetId)?.price;
      if (oraclePrice === undefined) {
        throw new Error(`Failed to get oracle price for asset: ${assetId}`);
      }
      if (auction.type === AuctionType.Liquidation) {
        // liquidation auction lots are in bTokens
        effectiveCollateral += reserve.toEffectiveAssetFromBTokenFloat(amount) * oraclePrice;
        lotValue += reserve.toAssetFromBTokenFloat(amount) * (dbPrice ?? oraclePrice);
      } else {
        lotValue +=
          (Number(amount) / 10 ** reserve.tokenMetadata.decimals) * (dbPrice ?? oraclePrice);
      }
    } else if (auction.type === AuctionType.BadDebt) {
      if (assetId !== APP_CONFIG.backstopTokenAddress) {
        throw new Error(
          `Unexpected bad debt auction. Lot contains asset other than the backstop token: ${assetId}`
        );
      }
      bidValue += await valueBackstopTokenInUSDC(sorobanHelper, amount);
    } else {
      throw new Error(`Failed to value lot asset: ${assetId}`);
    }
  }

  for (const [assetId, amount] of auction.data.bid) {
    if (auction.type === AuctionType.Liquidation || auction.type === AuctionType.BadDebt) {
      const reserve = reserves.get(assetId);
      if (reserve === undefined) {
        throw new Error(`Unexpected auction. Bid contains asset that is not a reserve: ${assetId}`);
      }
      const dbPrice = db.getPriceEntry(assetId)?.price;
      const oraclePrice = poolOracle.getPriceFloat(assetId);
      if (oraclePrice === undefined) {
        throw new Error(`Failed to get oracle price for asset: ${assetId}`);
      }
      effectiveLiabilities += reserve.toEffectiveAssetFromDTokenFloat(amount) * oraclePrice;
      bidValue += reserve.toAssetFromDTokenFloat(amount) * (dbPrice ?? oraclePrice);
      const fillerBalance = fillerBalances.get(assetId) ?? 0n;
      if (fillerBalance > 0) {
        const liabilityAmount = reserve.toAssetFromDToken(amount);
        const repaymentAmount = liabilityAmount <= fillerBalance ? liabilityAmount : fillerBalance;
        const repayableLiability =
          FixedMath.toFloat(repaymentAmount, reserve.config.decimals) *
          reserve.getLiabilityFactor() *
          oraclePrice;
        repayableLiabilities += repayableLiability;
        logger.info(
          `Filler can repay ${assetId} amount ${FixedMath.toFloat(repaymentAmount)} to cover liabilities: ${repayableLiability}`
        );
      }
    } else if (auction.type === AuctionType.Interest) {
      if (assetId !== APP_CONFIG.backstopTokenAddress) {
        throw new Error(
          `Unexpected interest auction. Bid contains asset other than the backstop token: ${assetId}`
        );
      }
      bidValue += await valueBackstopTokenInUSDC(sorobanHelper, amount);
    } else {
      throw new Error(`Failed to value bid asset: ${assetId}`);
    }
  }

  return { effectiveCollateral, effectiveLiabilities, repayableLiabilities, lotValue, bidValue };
}

/**
 * Value an amount of backstop tokens in USDC.
 * @param sorobanHelper - The soroban helper to use for the calculation
 * @param amount - The amount of backstop tokens to value
 * @returns The value of the backstop tokens in USDC
 */
export async function valueBackstopTokenInUSDC(
  sorobanHelper: SorobanHelper,
  amount: bigint
): Promise<number> {
  // attempt to value via a single sided withdraw to USDC
  const lpTokenValue = await sorobanHelper.simLPTokenToUSDC(amount);
  if (lpTokenValue !== undefined) {
    return FixedMath.toFloat(lpTokenValue, 7);
  } else {
    const backstopToken = await sorobanHelper.loadBackstopToken();
    return FixedMath.toFloat(amount, 7) * backstopToken.lpTokenPrice;
  }
}

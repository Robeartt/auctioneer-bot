import { AuctionData, FixedMath, Request, RequestType } from '@blend-capital/blend-sdk';
import { Asset } from '@stellar/stellar-sdk';
import { AuctionBid } from './bidder_submitter.js';
import { getFillerProfitPct } from './filler.js';
import { APP_CONFIG, Filler } from './utils/config.js';
import { AuctioneerDatabase, AuctionType } from './utils/db.js';
import { logger } from './utils/logger.js';
import { SorobanHelper } from './utils/soroban_helper.js';

export interface FillCalculation {
  // The block number to fill the auction at
  fillBlock: number;
  // The percent of the auction to fill
  fillPercent: number;
}

export interface AuctionValue {
  effectiveCollateral: number;
  effectiveLiabilities: number;
  lotValue: number;
  bidValue: number;
}

/**
 * Calculate the block fill and fill percent for a given auction.
 *
 * @param filler - The filler to calculate the block fill for
 * @param auctionType - The type of auction to calculate the block fill for
 * @param auctionData - The auction data to calculate the block fill for
 * @param sorobanHelper - The soroban helper to use for the calculation
 */
export async function calculateBlockFillAndPercent(
  filler: Filler,
  auctionType: AuctionType,
  auctionData: AuctionData,
  sorobanHelper: SorobanHelper,
  db: AuctioneerDatabase
): Promise<FillCalculation> {
  // Sum the effective collateral and lot value
  let { effectiveCollateral, effectiveLiabilities, lotValue, bidValue } =
    await calculateAuctionValue(auctionType, auctionData, sorobanHelper, db);
  let fillBlockDelay = 0;
  let fillPercent = 100;
  logger.info(
    `Auction Valuation: Effective Collateral: ${effectiveCollateral}, Effective Liabilities: ${effectiveLiabilities}, Lot Value: ${lotValue}, Bid Value: ${bidValue}`
  );

  // find the block delay where the auction meets the required profit percentage
  const profitPercent = getFillerProfitPct(filler, APP_CONFIG.profits ?? [], auctionData);
  if (lotValue >= bidValue * (1 + profitPercent)) {
    const minLotAmount = bidValue * (1 + profitPercent);
    fillBlockDelay = 200 - (lotValue - minLotAmount) / (lotValue / 200);
  } else {
    const maxBidAmount = lotValue * (1 - profitPercent);
    fillBlockDelay = 200 + (bidValue - maxBidAmount) / (bidValue / 200);
  }
  fillBlockDelay = Math.min(Math.max(Math.ceil(fillBlockDelay), 0), 400);

  // Ensure the filler can fully fill interest auctions
  if (auctionType === AuctionType.Interest) {
    const cometLpTokenBalance = FixedMath.toFloat(
      await sorobanHelper.simBalance(APP_CONFIG.backstopTokenAddress, filler.keypair.publicKey()),
      7
    );
    const cometLpBid =
      fillBlockDelay <= 200
        ? FixedMath.toFloat(auctionData.bid.get(APP_CONFIG.backstopTokenAddress)!, 7)
        : FixedMath.toFloat(auctionData.bid.get(APP_CONFIG.backstopTokenAddress)!, 7) *
          (1 - (fillBlockDelay - 200) / 200);

    if (cometLpTokenBalance < cometLpBid) {
      const additionalCometLp = cometLpBid - cometLpTokenBalance;
      const bidStepSize =
        FixedMath.toFloat(auctionData.bid.get(APP_CONFIG.backstopTokenAddress)!, 7) / 200;
      if (additionalCometLp >= 0 && bidStepSize > 0) {
        fillBlockDelay += Math.ceil(additionalCometLp / bidStepSize);
        fillBlockDelay = Math.min(fillBlockDelay, 400);
      }
    }
  }
  // Ensure the filler can maintain their minimum health factor
  else {
    const { estimate: fillerPositionEstimates } = await sorobanHelper.loadUserPositionEstimate(
      filler.keypair.publicKey()
    );
    if (fillBlockDelay <= 200) {
      effectiveCollateral = effectiveCollateral * (fillBlockDelay / 200);
    } else {
      effectiveLiabilities = effectiveLiabilities * (1 - (fillBlockDelay - 200) / 200);
    }
    if (effectiveCollateral < effectiveLiabilities) {
      const excessLiabilities = effectiveLiabilities - effectiveCollateral;
      const liabilityLimitToHF =
        fillerPositionEstimates.totalEffectiveCollateral / filler.minHealthFactor -
        fillerPositionEstimates.totalEffectiveLiabilities;

      if (excessLiabilities > liabilityLimitToHF) {
        fillPercent = Math.min(
          fillPercent,
          Math.floor((liabilityLimitToHF / excessLiabilities) * 100)
        );
      }
    }
  }

  if (auctionType === AuctionType.Liquidation && filler.forceFill) {
    fillBlockDelay = Math.min(fillBlockDelay, 198);
  } else if (auctionType === AuctionType.Interest && filler.forceFill) {
    fillBlockDelay = Math.min(fillBlockDelay, 350);
  }
  return { fillBlock: auctionData.block + fillBlockDelay, fillPercent };
}

/**
 * Scale an auction to the block the auction is to be filled and the percent which will be filled.
 * @param auction - The auction to scale
 * @param fillBlock - The block to scale to
 * @param fillPercent - The percent to scale to
 * @returns The scaled auction
 */
export function scaleAuction(
  auction: AuctionData,
  fillBlock: number,
  fillPercent: number
): AuctionData {
  let scaledAuction: AuctionData = {
    block: fillBlock,
    bid: new Map(),
    lot: new Map(),
  };
  let lotModifier;
  let bidModifier;
  const fillBlockDelta = fillBlock - auction.block;
  if (fillBlockDelta <= 200) {
    lotModifier = fillBlockDelta / 200;
    bidModifier = 1;
  } else {
    lotModifier = 1;
    if (fillBlockDelta < 400) {
      bidModifier = 1 - (fillBlockDelta - 200) / 200;
    } else {
      bidModifier = 0;
    }
  }

  for (const [assetId, amount] of auction.lot) {
    const scaledLot = Math.floor((Number(amount) * lotModifier * fillPercent) / 100);
    if (scaledLot > 0) {
      scaledAuction.lot.set(assetId, BigInt(scaledLot));
    }
  }
  for (const [assetId, amount] of auction.bid) {
    const scaledBid = Math.ceil((Number(amount) * bidModifier * fillPercent) / 100);
    if (scaledBid > 0) {
      scaledAuction.bid.set(assetId, BigInt(scaledBid));
    }
  }
  return scaledAuction;
}

/**
 * Build requests to fill the auction and repay the liabilities.
 * @param auctionBid - The auction to build the fill requests for
 * @param auctionData - The scaled auction data to build the fill requests for
 * @param fillPercent - The percent to fill the auction
 * @param sorobanHelper - The soroban helper to use for the calculation
 * @returns
 */
export async function buildFillRequests(
  auctionBid: AuctionBid,
  auctionData: AuctionData,
  fillPercent: number,
  sorobanHelper: SorobanHelper
): Promise<Request[]> {
  let fillRequests: Request[] = [];
  let requestType: RequestType;
  switch (auctionBid.auctionEntry.auction_type) {
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
    address: auctionBid.auctionEntry.user_id,
    amount: BigInt(fillPercent),
  });

  if (auctionBid.auctionEntry.auction_type === AuctionType.Interest) {
    return fillRequests;
  }

  // attempt to repay any liabilities the filler has took on from the bids
  // if this fails for some reason, still continue with the fill
  try {
    for (const [assetId] of auctionData.bid) {
      let tokenBalance = await sorobanHelper.simBalance(
        assetId,
        auctionBid.filler.keypair.publicKey()
      );
      if (assetId === Asset.native().contractId(APP_CONFIG.networkPassphrase)) {
        tokenBalance =
          tokenBalance > FixedMath.toFixed(50, 7) ? tokenBalance - FixedMath.toFixed(50, 7) : 0n;
      }
      if (tokenBalance > 0) {
        fillRequests.push({
          request_type: RequestType.Repay,
          address: assetId,
          amount: BigInt(tokenBalance),
        });
      }
    }
  } catch (e: any) {
    logger.error(`Error attempting to repay dToken bids for filler: ${auctionBid.filler.name}`, e);
  }
  return fillRequests;
}

/**
 * Calculate the effective collateral, lot value, effective liabilities, and bid value for an auction.
 *
 * If this function encounters an error, it will return 0 for all values.
 *
 * @param auctionType - The type of auction to calculate the values for
 * @param auctionData - The auction data to calculate the values for
 * @param sorobanHelper - A helper to use for loading ledger data
 * @param db - The database to use for fetching asset prices
 * @returns The calculated values, or 0 for all values if it is unable to calculate them
 */
export async function calculateAuctionValue(
  auctionType: AuctionType,
  auctionData: AuctionData,
  sorobanHelper: SorobanHelper,
  db: AuctioneerDatabase
): Promise<AuctionValue> {
  try {
    let effectiveCollateral = 0;
    let lotValue = 0;
    let effectiveLiabilities = 0;
    let bidValue = 0;
    const reserves = (await sorobanHelper.loadPool()).reserves;
    const poolOracle = await sorobanHelper.loadPoolOracle();
    for (const [assetId, amount] of auctionData.lot) {
      const reserve = reserves.get(assetId);
      if (reserve !== undefined) {
        const oraclePrice = poolOracle.getPriceFloat(assetId);
        const dbPrice = db.getPriceEntry(assetId)?.price;
        if (oraclePrice === undefined) {
          throw new Error(`Failed to get oracle price for asset: ${assetId}`);
        }

        if (auctionType !== AuctionType.Interest) {
          effectiveCollateral += reserve.toEffectiveAssetFromBTokenFloat(amount) * oraclePrice;
          // TODO: change this to use the price in the db
          lotValue += reserve.toAssetFromBTokenFloat(amount) * (dbPrice ?? oraclePrice);
        }
        // Interest auctions are in underlying assets
        else {
          lotValue +=
            (Number(amount) / 10 ** reserve.tokenMetadata.decimals) * (dbPrice ?? oraclePrice);
        }
      } else if (assetId === APP_CONFIG.backstopTokenAddress) {
        // Simulate singled sided withdraw to USDC
        const lpTokenValue = await sorobanHelper.simLPTokenToUSDC(amount);
        if (lpTokenValue !== undefined) {
          lotValue += FixedMath.toFloat(lpTokenValue, 7);
        }
        // Approximate the value of the comet tokens if simulation fails
        else {
          const backstopToken = await sorobanHelper.loadBackstopToken();
          lotValue += FixedMath.toFloat(amount, 7) * backstopToken.lpTokenPrice;
        }
      } else {
        throw new Error(`Failed to value lot asset: ${assetId}`);
      }
    }

    for (const [assetId, amount] of auctionData.bid) {
      const reserve = reserves.get(assetId);
      const dbPrice = db.getPriceEntry(assetId)?.price;

      if (reserve !== undefined) {
        const oraclePrice = poolOracle.getPriceFloat(assetId);
        if (oraclePrice === undefined) {
          throw new Error(`Failed to get oracle price for asset: ${assetId}`);
        }

        effectiveLiabilities += reserve.toEffectiveAssetFromDTokenFloat(amount) * oraclePrice;
        // TODO: change this to use the price in the db
        bidValue += reserve.toAssetFromDTokenFloat(amount) * (dbPrice ?? oraclePrice);
      } else if (assetId === APP_CONFIG.backstopTokenAddress) {
        // Simulate singled sided withdraw to USDC
        const lpTokenValue = await sorobanHelper.simLPTokenToUSDC(amount);
        if (lpTokenValue !== undefined) {
          bidValue += FixedMath.toFloat(lpTokenValue, 7);
        } else {
          const backstopToken = await sorobanHelper.loadBackstopToken();
          bidValue += FixedMath.toFloat(amount, 7) * backstopToken.lpTokenPrice;
        }
      } else {
        throw new Error(`Failed to value bid asset: ${assetId}`);
      }
    }

    return { effectiveCollateral, effectiveLiabilities, lotValue, bidValue };
  } catch (e: any) {
    logger.error(`Error calculating auction value`, e);
    return { effectiveCollateral: 0, effectiveLiabilities: 0, lotValue: 0, bidValue: 0 };
  }
}

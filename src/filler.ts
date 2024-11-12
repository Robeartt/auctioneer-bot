import {
  FixedMath,
  Pool,
  PoolOracle,
  Positions,
  PositionsEstimate,
  Request,
  RequestType,
  Reserve,
} from '@blend-capital/blend-sdk';
import { Asset } from '@stellar/stellar-sdk';
import { APP_CONFIG, Filler } from './utils/config.js';
import { stringify } from './utils/json.js';
import { logger } from './utils/logger.js';

/**
 * Manage a filler's positions in the pool. Returns an array of requests to be submitted to the network. This function
 * will attempt to repay liabilities with the filler's assets, and withdraw any unnecessary collateral, up to either the min
 * collateral balance or the min health factor.
 *
 * Note - some buffer is applied to ensure that subsequent calls to "managePositions" does not create dust.
 *
 * @param filler - The filler
 * @param pool - The pool
 * @param poolOracle - The pool's oracle object
 * @param poolUser - The filler's pool user object
 * @param balances - The filler's balances
 * @returns An array of requests to be submitted to the network, or an empty array if no actions are required
 */
export function managePositions(
  filler: Filler,
  pool: Pool,
  poolOracle: PoolOracle,
  positions: Positions,
  balances: Map<string, bigint>
): Request[] {
  let requests: Request[] = [];
  const positionsEst = PositionsEstimate.build(pool, poolOracle, positions);
  let effectiveLiabilities = positionsEst.totalEffectiveLiabilities;
  let effectiveCollateral = positionsEst.totalEffectiveCollateral;

  const hasLeftoverLiabilities: number[] = [];
  // attempt to repay any liabilities the filler has
  for (const [assetIndex, amount] of positions.liabilities) {
    const reserve = pool.reserves.get(pool.config.reserveList[assetIndex]);
    // this should never happen
    if (reserve === undefined) {
      logger.error(
        `UNEXPECTED: Reserve not found for asset index: ${assetIndex}, positions: ${stringify(positions)}`
      );
      continue;
    }
    // if no price is found, assume 0, so effective liabilities won't change
    const oraclePrice = poolOracle.getPriceFloat(reserve.assetId) ?? 0;
    const isNative = reserve.assetId === Asset.native().contractId(APP_CONFIG.networkPassphrase);
    let tokenBalance = balances.get(reserve.assetId) ?? 0n;
    // require that at least 50 XLM is left in the wallet
    if (isNative) {
      tokenBalance =
        tokenBalance > FixedMath.toFixed(50, 7) ? tokenBalance - FixedMath.toFixed(50, 7) : 0n;
    }
    if (tokenBalance > 0n) {
      const balanceAsDTokens = reserve.toDTokensFromAssetFloor(tokenBalance);
      const repaidLiability = balanceAsDTokens <= amount ? balanceAsDTokens : amount;
      if (balanceAsDTokens <= amount) {
        hasLeftoverLiabilities.push(assetIndex);
      }
      const effectiveLiability =
        reserve.toEffectiveAssetFromDTokenFloat(repaidLiability) * oraclePrice;
      effectiveLiabilities -= effectiveLiability;
      // repay will pull down repayment amount if greater than liabilities
      requests.push({
        request_type: RequestType.Repay,
        address: reserve.assetId,
        amount: tokenBalance,
      });
    }
  }

  // short circuit collateral withdrawal if close to min hf
  // this avoids very small amout of dust collateral being withdrawn and
  // causing unwind events to loop
  if (filler.minHealthFactor * 1.01 > effectiveCollateral / effectiveLiabilities) {
    return requests;
  }

  // withdrawing collateral needs to be prioritized
  // 1. withdraw from assets where the filler maintains a liability
  // 2. withdraw positions completely to minimize # of positions
  // 3. if no liabilities, withdraw the pimary asset down to min collateral

  // build list of collateral so we can sort it by size ascending
  const collateralList: { reserve: Reserve; price: number; amount: bigint; size: number }[] = [];

  for (const [assetIndex, amount] of positions.collateral) {
    const reserve = pool.reserves.get(pool.config.reserveList[assetIndex]);
    // this should never happen
    if (reserve === undefined) {
      logger.error(
        `UNEXPECTED: Reserve not found for asset index: ${assetIndex}, positions: ${stringify(positions)}`
      );
      continue;
    }
    const price = poolOracle.getPriceFloat(reserve.assetId) ?? 0;
    if (price === 0) {
      logger.warn(
        `Unable to find price for asset: ${reserve.assetId}, skipping collateral withdrawal.`
      );
      continue;
    }
    // hacky - set size to zero for (1), to ensure they are withdrawn first
    if (hasLeftoverLiabilities.includes(assetIndex)) {
      collateralList.push({ reserve, price, amount, size: 0 });
    }
    // hacky - set size to MAX for (3), to ensure it is withdrawn last
    else if (reserve.assetId === filler.primaryAsset) {
      collateralList.push({ reserve, price, amount, size: Number.MAX_SAFE_INTEGER });
    } else {
      const size = reserve.toEffectiveAssetFromBTokenFloat(amount) * price;
      collateralList.push({ reserve, price, amount, size });
    }
  }
  collateralList.sort((a, b) => a.size - b.size);

  // attempt to withdraw any collateral that is not needed
  for (const { reserve, price, amount } of collateralList) {
    let withdrawAmount: bigint;
    if (hasLeftoverLiabilities.length === 0) {
      // no liabilities, withdraw the full position
      withdrawAmount = BigInt('9223372036854775807');
    } else {
      if (filler.minHealthFactor * 1.005 > effectiveCollateral / effectiveLiabilities) {
        // stop withdrawing collateral if close to min health factor
        break;
      }
      const maxWithdraw =
        (effectiveCollateral - effectiveLiabilities * filler.minHealthFactor) /
        (reserve.getCollateralFactor() * price);
      const position = reserve.toAssetFromBTokenFloat(amount);
      withdrawAmount =
        maxWithdraw > position ? BigInt('9223372036854775807') : FixedMath.toFixed(maxWithdraw, 7);
    }

    // if this is not a full withdrawal, and the colleratal is not also a liability, stop
    if (
      !hasLeftoverLiabilities.includes(reserve.config.index) &&
      withdrawAmount !== BigInt('9223372036854775807')
    ) {
      break;
    }
    // require the filler to keep at least the min collateral balance of their primary asset
    if (reserve.assetId === filler.primaryAsset) {
      const toMinPosition = reserve.toAssetFromBToken(amount) - filler.minPrimaryCollateral;
      withdrawAmount = withdrawAmount > toMinPosition ? toMinPosition : withdrawAmount;
    }
    const withdrawnBToken = reserve.toBTokensFromAssetFloor(withdrawAmount);
    effectiveCollateral -= reserve.toEffectiveAssetFromBTokenFloat(withdrawnBToken) * price;
    requests.push({
      request_type: RequestType.WithdrawCollateral,
      address: reserve.assetId,
      amount: withdrawAmount,
    });
  }
  return requests;
}

import { Pool, PoolOracle, Positions, PositionsEstimate } from '@blend-capital/blend-sdk';
import { updateUser } from './user.js';
import { APP_CONFIG } from './utils/config.js';
import { AuctioneerDatabase, AuctionType } from './utils/db.js';
import { logger } from './utils/logger.js';
import { SorobanHelper } from './utils/soroban_helper.js';
import { WorkSubmission, WorkSubmissionType } from './work_submitter.js';
import { sendSlackNotification } from './utils/slack_notifier.js';

/**
 * Check if a user is liquidatable
 * @param user - The positions estimate of the user
 * @returns true if the user is liquidatable, false otherwise
 */
export function isLiquidatable(user: PositionsEstimate): boolean {
  if (
    user.totalEffectiveLiabilities > 0 &&
    user.totalEffectiveCollateral > 0 &&
    user.totalEffectiveCollateral / user.totalEffectiveLiabilities < 0.998
  ) {
    return true;
  }
  return false;
}

/**
 * Check if a user had bad debt
 * @param user - The positions estimate of the user
 * @returns True if the user has bad debt, false otherwise
 */
export function isBadDebt(user: PositionsEstimate): boolean {
  if (user.totalEffectiveCollateral === 0 && user.totalEffectiveLiabilities > 0) {
    return true;
  }
  return false;
}

/**
 * Calculate the liquidation percent for position
 * @param user - The positions estimate of the user
 * @returns The liquidation percent
 */
export function calculateLiquidation(
  pool: Pool,
  user: Positions,
  estimate: PositionsEstimate,
  oracle: PoolOracle
): {
  auctionPercent: number;
  lot: string[];
  bid: string[];
} {
  let effectiveCollaterals: [number, number][] = [];
  let rawCollaterals: Map<string, number> = new Map();
  let effectiveLiabilities: [number, number][] = [];
  let rawLiabilities: Map<string, number> = new Map();

  for (let [index, amount] of user.collateral) {
    let assetId = pool.metadata.reserveList[index];
    let oraclePrice = oracle.getPriceFloat(assetId);
    let reserve = pool.reserves.get(assetId);
    if (oraclePrice === undefined || reserve === undefined) {
      continue;
    }
    let effectiveAmount = reserve.toEffectiveAssetFromBTokenFloat(amount) * oraclePrice;
    let rawAmount = reserve.toAssetFromBTokenFloat(amount) * oraclePrice;
    effectiveCollaterals.push([index, effectiveAmount]);
    rawCollaterals.set(assetId, rawAmount);
  }
  for (let [index, amount] of user.liabilities) {
    let assetId = pool.metadata.reserveList[index];
    let oraclePrice = oracle.getPriceFloat(assetId);
    let reserve = pool.reserves.get(assetId);
    if (oraclePrice === undefined || reserve === undefined) {
      continue;
    }
    let effectiveAmount = reserve.toEffectiveAssetFromDTokenFloat(amount) * oraclePrice;
    let rawAmount = reserve.toAssetFromDTokenFloat(amount) * oraclePrice;
    effectiveLiabilities.push([index, effectiveAmount]);
    rawLiabilities.set(assetId, rawAmount);
  }

  effectiveCollaterals.sort((a, b) => a[1] - b[1]);
  effectiveLiabilities.sort((a, b) => a[1] - b[1]);
  let firstCollateral = effectiveCollaterals.pop();
  let firstLiability = effectiveLiabilities.pop();

  if (firstCollateral === undefined || firstLiability === undefined) {
    throw new Error('No collaterals or liabilities found for liquidation calculation');
  }
  let auction = new Positions(
    new Map([[firstLiability[0], user.liabilities.get(firstLiability[0])!]]),
    new Map([[firstCollateral[0], user.collateral.get(firstCollateral[0])!]]),
    new Map()
  );
  let auctionEstimate = PositionsEstimate.build(pool, oracle, auction);

  let liabilitesToReduce = Math.max(
    0,
    estimate.totalEffectiveLiabilities * 1.06 - estimate.totalEffectiveCollateral
  );
  let liqPercent = calculateLiqPercent(auctionEstimate, liabilitesToReduce);
  while (liqPercent > 100 || liqPercent === 0) {
    if (liqPercent > 100) {
      let nextLiability = effectiveLiabilities.pop();
      if (nextLiability === undefined) {
        let nextCollateral = effectiveCollaterals.pop();
        if (nextCollateral === undefined) {
          return {
            auctionPercent: 100,
            lot: Array.from(auction.collateral).map(([index]) => pool.metadata.reserveList[index]),
            bid: Array.from(auction.liabilities).map(([index]) => pool.metadata.reserveList[index]),
          };
        }
        auction.collateral.set(nextCollateral[0], user.collateral.get(nextCollateral[0])!);
      } else {
        auction.liabilities.set(nextLiability[0], user.liabilities.get(nextLiability[0])!);
      }
    } else if (liqPercent == 0) {
      let nextCollateral = effectiveCollaterals.pop();
      if (nextCollateral === undefined) {
        // No more collaterals to liquidate
        return {
          auctionPercent: 100,
          lot: Array.from(auction.collateral).map(([index]) => pool.metadata.reserveList[index]),
          bid: Array.from(auction.liabilities)
            .map(([index]) => pool.metadata.reserveList[index])
            .concat(effectiveLiabilities.map(([index]) => pool.metadata.reserveList[index])),
        };
      }
      auction.collateral.set(nextCollateral[0], user.collateral.get(nextCollateral[0])!);
    }
    auctionEstimate = PositionsEstimate.build(pool, oracle, auction);
    liqPercent = calculateLiqPercent(auctionEstimate, liabilitesToReduce);
  }

  return {
    auctionPercent: liqPercent,
    lot: Array.from(auction.collateral).map(([index]) => pool.metadata.reserveList[index]),
    bid: Array.from(auction.liabilities).map(([index]) => pool.metadata.reserveList[index]),
  };
}

function calculateLiqPercent(positions: PositionsEstimate, excessLiabilities: number) {
  let avgCF = positions.totalEffectiveCollateral / positions.totalSupplied;
  let avgLF = positions.totalEffectiveLiabilities / positions.totalBorrowed;
  let estIncentive = 1 + (1 - avgCF / avgLF) / 2;
  // The factor by which the effective liabilities are reduced per raw liability
  let borrowLimitFactor = avgLF * 1.06 - estIncentive * avgCF;

  let totalBorrowLimitRecovered = borrowLimitFactor * positions.totalBorrowed;
  let liqPercent = Math.round((excessLiabilities / totalBorrowLimitRecovered) * 100);
  let requiredRawCollateral = (liqPercent / 100) * positions.totalBorrowed * estIncentive;

  if (requiredRawCollateral > positions.totalSupplied) {
    return 0; // Not enough collateral to cover the liquidation
  }

  return liqPercent;
}

/**
 * Check all tracked users for liquidations
 * @param db - The database
 * @param sorobanHelper - The soroban helper
 * @returns A list of liquidations to be submitted
 */
export async function scanUsers(
  db: AuctioneerDatabase,
  sorobanHelper: SorobanHelper
): Promise<WorkSubmission[]> {
  let userPoolMap = new Map<string, string[]>();
  let users = db.getUserEntriesUnderHealthFactor(1.2);
  for (const user of users) {
    if (!userPoolMap.has(user.pool_id)) {
      userPoolMap.set(user.pool_id, []);
    }
    userPoolMap.get(user.pool_id)!.push(user.user_id);
  }

  let submissions: WorkSubmission[] = [];
  for (const pool of APP_CONFIG.pools) {
    const users = userPoolMap.get(pool) || [];
    users.push(APP_CONFIG.backstopAddress);
    submissions.push(
      ...(await checkUsersForLiquidationsAndBadDebt(db, sorobanHelper, pool, users))
    );
  }
  return submissions;
}

/**
 * Check a provided list of users for liquidations and bad debt
 * @param db - The database
 * @param sorobanHelper - The soroban helper
 * @param users - The list of users to check
 * @returns A list of liquidations to be submitted
 */
export async function checkUsersForLiquidationsAndBadDebt(
  db: AuctioneerDatabase,
  sorobanHelper: SorobanHelper,
  poolId: string,
  user_ids: string[]
): Promise<WorkSubmission[]> {
  const pool = await sorobanHelper.loadPool(poolId);
  logger.info(`Checking ${user_ids.length} users for liquidations..`);
  let submissions: WorkSubmission[] = [];
  for (let user of user_ids) {
    try {
      // Check if the user already has a liquidation auction
      if (user === APP_CONFIG.backstopAddress) {
        const { estimate: backstopPostionsEstimate, user: backstop } =
          await sorobanHelper.loadUserPositionEstimate(poolId, user);
        if (
          isBadDebt(backstopPostionsEstimate) &&
          (await sorobanHelper.loadAuction(poolId, user, AuctionType.BadDebt)) === undefined
        ) {
          submissions.push({
            type: WorkSubmissionType.AuctionCreation,
            poolId,
            user: APP_CONFIG.backstopAddress,
            auctionType: AuctionType.BadDebt,
            auctionPercent: 100,
            bid: Array.from(backstop.positions.liabilities.keys()).map(
              (index) => pool.metadata.reserveList[index]
            ),
            lot: [APP_CONFIG.backstopTokenAddress],
          });
        }
      } else if (
        (await sorobanHelper.loadAuction(poolId, user, AuctionType.Liquidation)) === undefined
      ) {
        const { estimate: poolUserEstimate, user: poolUser } =
          await sorobanHelper.loadUserPositionEstimate(poolId, user);
        const oracle = await sorobanHelper.loadPoolOracle(poolId);
        updateUser(db, pool, poolUser, poolUserEstimate);
        if (isLiquidatable(poolUserEstimate)) {
          const newLiq = calculateLiquidation(pool, poolUser.positions, poolUserEstimate, oracle);
          submissions.push({
            type: WorkSubmissionType.AuctionCreation,
            poolId,
            user,
            auctionPercent: newLiq.auctionPercent,
            auctionType: AuctionType.Liquidation,
            bid: Array.from(poolUser.positions.liabilities.keys()).map(
              (index) => pool.metadata.reserveList[index]
            ),
            lot: Array.from(poolUser.positions.collateral.keys()).map(
              (index) => pool.metadata.reserveList[index]
            ),
          });
        } else if (isBadDebt(poolUserEstimate)) {
          submissions.push({
            type: WorkSubmissionType.BadDebtTransfer,
            poolId,
            user: user,
          });
        }
      }
    } catch (e) {
      const errorLog =
        `Error checking for bad debt or liquidation\n` +
        `Pool: ${poolId}\n` +
        `User: ${user}\n` +
        `Error: ${e}`;
      logger.error(errorLog);
      sendSlackNotification(errorLog);
    }
  }
  return submissions;
}

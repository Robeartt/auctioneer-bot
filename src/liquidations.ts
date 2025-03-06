import { PositionsEstimate } from '@blend-capital/blend-sdk';
import { updateUser } from './user.js';
import { APP_CONFIG, PoolConfig } from './utils/config.js';
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
export function calculateLiquidationPercent(user: PositionsEstimate): bigint {
  const avgInverseLF = user.totalEffectiveLiabilities / user.totalBorrowed;
  const avgCF = user.totalEffectiveCollateral / user.totalSupplied;
  const estIncentive = 1 + (1 - avgCF / avgInverseLF) / 2;
  const numerator = user.totalEffectiveLiabilities * 1.06 - user.totalEffectiveCollateral;
  const denominator = avgInverseLF * 1.06 - avgCF * estIncentive;
  const liqPercent = BigInt(
    Math.min(Math.round((numerator / denominator / user.totalBorrowed) * 100), 100)
  );
  logger.info(
    `Calculated liquidation percent ${liqPercent} with est incentive ${estIncentive} numerator ${numerator} and denominator ${denominator} for user ${user}.`
  );
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
  for (const poolConfig of APP_CONFIG.poolConfigs) {
    const users = userPoolMap.get(poolConfig.poolAddress) || [];
    users.push(APP_CONFIG.backstopAddress);
    submissions.push(
      ...(await checkUsersForLiquidationsAndBadDebt(db, sorobanHelper, poolConfig, users))
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
  poolConfig: PoolConfig,
  user_ids: string[]
): Promise<WorkSubmission[]> {
  const pool = await sorobanHelper.loadPool(poolConfig);
  logger.info(`Checking ${user_ids.length} users for liquidations..`);
  let submissions: WorkSubmission[] = [];
  for (let user of user_ids) {
    try {
      // Check if the user already has a liquidation auction
      if (user === APP_CONFIG.backstopAddress) {
        const { estimate: backstopPostionsEstimate, user: backstop } =
          await sorobanHelper.loadUserPositionEstimate(poolConfig, user);
        if (
          isBadDebt(backstopPostionsEstimate) &&
          (await sorobanHelper.loadAuction(poolConfig, user, AuctionType.BadDebt)) === undefined
        ) {
          submissions.push({
            type: WorkSubmissionType.BadDebtAuction,
            poolConfig,
          });
        }
      } else if (
        (await sorobanHelper.loadAuction(poolConfig, user, AuctionType.Liquidation)) === undefined
      ) {
        const { estimate: poolUserEstimate, user: poolUser } =
          await sorobanHelper.loadUserPositionEstimate(poolConfig, user);
        updateUser(db, pool, poolUser, poolUserEstimate);
        if (isLiquidatable(poolUserEstimate)) {
          const liquidationPercent = calculateLiquidationPercent(poolUserEstimate);
          submissions.push({
            type: WorkSubmissionType.LiquidateUser,
            poolConfig,
            user: user,
            liquidationPercent: liquidationPercent,
          });
        } else if (isBadDebt(poolUserEstimate)) {
          submissions.push({
            type: WorkSubmissionType.BadDebtTransfer,
            poolConfig,
            user: user,
          });
        }
      }
    } catch (e) {
      logger.error(`Error checking user ${user} for bad debt or liquidation: ${e}`);
      sendSlackNotification(
        poolConfig,
        `Error checking user ${user} for bad debt or liquidation: ${e}`
      );
    }
  }
  return submissions;
}

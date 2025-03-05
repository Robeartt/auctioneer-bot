import { AppEvent, EventType } from './events.js';
import { checkUsersForLiquidationsAndBadDebt, scanUsers } from './liquidations.js';
import { OracleHistory } from './oracle_history.js';
import { updateUser } from './user.js';
import { APP_CONFIG } from './utils/config.js';
import { AuctioneerDatabase } from './utils/db.js';
import { logger } from './utils/logger.js';
import { deadletterEvent } from './utils/messages.js';
import { setPrices } from './utils/prices.js';
import { sendSlackNotification } from './utils/slack_notifier.js';
import { SorobanHelper } from './utils/soroban_helper.js';
import { WorkSubmitter } from './work_submitter.js';

const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;

/**
 * Event handler for processing events.
 */
export class WorkHandler {
  private db: AuctioneerDatabase;
  private submissionQueue: WorkSubmitter;
  private oracleHistory: OracleHistory;
  private sorobanHelper: SorobanHelper;
  constructor(
    db: AuctioneerDatabase,
    submissionQueue: WorkSubmitter,
    oracleHistory: OracleHistory,
    sorobanHelper: SorobanHelper
  ) {
    this.db = db;
    this.submissionQueue = submissionQueue;
    this.oracleHistory = oracleHistory;
    this.sorobanHelper = sorobanHelper;
  }

  /**
   * Process an app event with retries. If the event cannot be processed, it
   * is persisted to the dead letter queue.
   *
   * @param appEvent - The event to process
   * @returns True if the event was successfully processed, false otherwise.
   */
  async processEventWithRetryAndDeadletter(appEvent: AppEvent): Promise<boolean> {
    let retries = 0;
    while (true) {
      try {
        await this.processEvent(appEvent);
        logger.info(`Successfully processed event.`);
        return true;
      } catch (error) {
        retries++;
        if (retries >= MAX_RETRIES) {
          if (appEvent.type === EventType.VALIDATE_POOLS) {
            throw error;
          }
          await deadletterEvent(appEvent);
          return false;
        }
        logger.warn(`Error processing ${appEvent.type}.`, error);
        logger.warn(
          `Retry ${retries + 1}/${MAX_RETRIES}. Waiting ${RETRY_DELAY}ms before next attempt.`
        );
        // Both of these logs above exist, and are the last things logged by timestamp
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
      }
    }
  }

  /**
   * Process an event.
   *
   * This function will return if it successfully processed the event.
   * If the event fails to process, it will throw an error.
   *
   * @param appEvent - The event to process
   */
  async processEvent(appEvent: AppEvent): Promise<void> {
    switch (appEvent.type) {
      case EventType.VALIDATE_POOLS: {
        for (const config of appEvent.pools) {
          try {
            const pool = await this.sorobanHelper.loadPool(config);
            if (pool.metadata.backstop !== config.backstopAddress) {
              throw new Error(
                `Pool backstop address ${pool.metadata.backstop} does not match config ${config.backstopAddress}`
              );
            }
          } catch (error) {
            throw new Error(
              `Failed to load pool: ${config.poolAddress} please check that the pool config is correct. Error: ${error}`
            );
          }
        }
        break;
      }

      case EventType.PRICE_UPDATE: {
        await setPrices(this.db);
        break;
      }
      case EventType.ORACLE_SCAN: {
        let usersToCheck = new Set<string>();
        const test = new Map<string, Set<string>>();
        for (const poolConfig of APP_CONFIG.poolConfigs) {
          const poolOracle = await this.sorobanHelper.loadPoolOracle(poolConfig);
          const priceChanges = this.oracleHistory.getSignificantPriceChanges(poolOracle);
          // @dev: Insert into a set to ensure uniqueness
          for (const assetId of priceChanges.up) {
            const usersWithLiability = this.db.getUserEntriesWithLiability(
              poolConfig.poolAddress,
              assetId
            );
            for (const user of usersWithLiability) {
              usersToCheck.add(user.user_id);
            }
          }
          for (const assetId of priceChanges.down) {
            const usersWithCollateral = this.db.getUserEntriesWithCollateral(
              poolConfig.poolAddress,
              assetId
            );
            for (const user of usersWithCollateral) {
              usersToCheck.add(user.user_id);
            }
          }
          const liquidations = await checkUsersForLiquidationsAndBadDebt(
            this.db,
            this.sorobanHelper,
            poolConfig,
            Array.from(usersToCheck)
          );
          for (const liquidation of liquidations) {
            this.submissionQueue.addSubmission(liquidation, 3);
          }
        }
        break;
      }
      case EventType.LIQ_SCAN: {
        for (const poolConfig of APP_CONFIG.poolConfigs) {
          const liquidations = await scanUsers(this.db, this.sorobanHelper, poolConfig);
          for (const liquidation of liquidations) {
            this.submissionQueue.addSubmission(liquidation, 3);
          }
        }
        break;
      }
      case EventType.USER_REFRESH: {
        const oldUsers = this.db.getUserEntriesUpdatedBefore(appEvent.cutoff);
        if (oldUsers.length === 0) {
          return;
        }

        for (const user of oldUsers) {
          try {
            const poolConfig = APP_CONFIG.poolConfigs.find((p) => p.poolAddress === user.pool_id);
            if (!poolConfig) {
              if (user.updated < appEvent.cutoff) {
                this.db.deleteUserEntry(user.pool_id, user.user_id);
                logger.warn(
                  `Pool config not found for user: ${user.user_id} in pool: ${user.pool_id}. Deleting user.`
                );
              }
              continue;
            }
            if (user.updated < appEvent.cutoff) {
              const logMessage = `User: ${user.user_id} in Pool: ${user.pool_id} has not updated since ledger: ${appEvent.cutoff}.`;
              logger.error(logMessage);
              await sendSlackNotification(poolConfig, logMessage);
            }
            const pool = await this.sorobanHelper.loadPool(poolConfig);

            const { estimate: poolUserEstimate, user: poolUser } =
              await this.sorobanHelper.loadUserPositionEstimate(poolConfig, user.user_id);
            updateUser(this.db, pool, poolUser, poolUserEstimate);
          } catch (e) {
            logger.error(`Error refreshing user ${user.user_id} in pool ${user.pool_id}: ${e}`);
          }
        }
        break;
      }
      case EventType.CHECK_USER: {
        const submissions = await checkUsersForLiquidationsAndBadDebt(
          this.db,
          this.sorobanHelper,
          appEvent.poolConfig,
          [appEvent.userId]
        );
        for (const submission of submissions) {
          this.submissionQueue.addSubmission(submission, 3);
        }
        break;
      }
      case EventType.DB_MIGRATION_V2: {
        const currLedger = await this.sorobanHelper.loadLatestLedger();
        const users = this.db.getUserEntriesUpdatedBefore(currLedger + 1);

        for (const user of users) {
          if (user.pool_id === 'default_pool') {
            for (const poolConfig of appEvent.poolConfigs) {
              const pool = await this.sorobanHelper.loadPool(poolConfig);
              try {
                const { estimate: poolUserEstimate, user: poolUser } =
                  await this.sorobanHelper.loadUserPositionEstimate(poolConfig, user.user_id);
                if (poolUserEstimate.totalEffectiveLiabilities > 0n) {
                  updateUser(this.db, pool, poolUser, poolUserEstimate);
                }
              } catch {
                // @dev: Ignore errors for users that don't exist in the pool
              }
            }
            this.db.deleteUserEntry('default_pool', user.user_id);
          }
        }

        for (const poolConfig of appEvent.poolConfigs) {
          const auctions = this.db.getAllAuctionEntries();
          for (const auctionEntry of auctions) {
            try {
              if (auctionEntry.pool_id === 'default_pool') {
                const auction = await this.sorobanHelper.loadAuction(
                  poolConfig,
                  auctionEntry.user_id,
                  auctionEntry.auction_type
                );
                if (auction) {
                  this.db.setAuctionEntry({
                    pool_id: poolConfig.poolAddress,
                    user_id: auctionEntry.user_id,
                    auction_type: auctionEntry.auction_type,
                    filler: auctionEntry.filler,
                    start_block: auctionEntry.start_block,
                    fill_block: auctionEntry.fill_block,
                    updated: auctionEntry.updated,
                  });
                  this.db.deleteAuctionEntry(
                    'default_pool',
                    auctionEntry.user_id,
                    auctionEntry.auction_type
                  );
                } else {
                  break;
                }
              }
            } catch {
              // @dev: Ignore errors for auctions that don't exist in the pool
            }
          }
        }
      }

      default:
        logger.error(`Unhandled event type: ${appEvent.type}`);
        break;
    }
  }
}

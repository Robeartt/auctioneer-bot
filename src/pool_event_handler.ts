import { PoolEventType } from '@blend-capital/blend-sdk';
import { ChildProcess } from 'child_process';
import { EventType, PoolEventEvent } from './events.js';
import { canFillerBid } from './filler.js';
import { updateUser } from './user.js';
import { APP_CONFIG } from './utils/config.js';
import { AuctioneerDatabase, AuctionEntry, AuctionType } from './utils/db.js';
import { stringify } from './utils/json.js';
import { logger } from './utils/logger.js';
import { deadletterEvent, sendEvent } from './utils/messages.js';
import { sendSlackNotification } from './utils/slack_notifier.js';
import { SorobanHelper } from './utils/soroban_helper.js';
import { WorkSubmission } from './work_submitter.js';
const MAX_RETRIES = 2;
const RETRY_DELAY = 200;

/**
 * Event handler for processing events on the work queue.
 */
export class PoolEventHandler {
  private db: AuctioneerDatabase;
  private sorobanHelper: SorobanHelper;
  private worker: ChildProcess;

  constructor(db: AuctioneerDatabase, sorobanHelper: SorobanHelper, worker: ChildProcess) {
    this.db = db;
    this.sorobanHelper = sorobanHelper;
    this.worker = worker;
  }

  /**
   * Process a pool event from with retries. If the event cannot be processed, it
   * is persisted to the dead letter queue.
   *
   * @param appEvent - The event to process
   */
  async processEventWithRetryAndDeadLetter(
    poolEvent: PoolEventEvent
  ): Promise<void | WorkSubmission> {
    let retries = 0;
    while (true) {
      try {
        await this.handlePoolEvent(poolEvent);
        logger.info(`Successfully processed event. ${poolEvent.event.id}`);
        return;
      } catch (error: any) {
        retries++;
        if (retries >= MAX_RETRIES) {
          try {
            await deadletterEvent(poolEvent);
          } catch (error: any) {
            logger.error(`Error sending event to dead letter queue.`, error);
          }
          return;
        }
        logger.warn(`Error processing event. ${poolEvent.event.id}.`, error);
        logger.warn(
          `Retry ${retries + 1}/${MAX_RETRIES}. Waiting ${RETRY_DELAY}ms before next attempt.`
        );
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
      }
    }
  }

  /**
   * Handle a pool event.
   * @param poolEvent - The pool event to handle
   */
  async handlePoolEvent(poolEvent: PoolEventEvent): Promise<void> {
    const poolConfig = APP_CONFIG.poolConfigs.find(
      (config) => config.poolAddress === poolEvent.event.contractId
    );
    if (!poolConfig) {
      logger.error(`Pool config not found for event: ${stringify(poolEvent.event)}`);
      return;
    }

    const pool = await this.sorobanHelper.loadPool(poolConfig);
    switch (poolEvent.event.eventType) {
      case PoolEventType.SupplyCollateral:
      case PoolEventType.WithdrawCollateral:
      case PoolEventType.Borrow:
      case PoolEventType.Repay: {
        // update the user in the db
        const { estimate: userPositionsEstimate, user } =
          await this.sorobanHelper.loadUserPositionEstimate(poolConfig, poolEvent.event.from);
        updateUser(this.db, pool, user, userPositionsEstimate, poolEvent.event.ledger);
        break;
      }
      case PoolEventType.NewLiquidationAuction:
      case PoolEventType.NewAuction: {
        let auction_type: AuctionType;
        if ('auctionType' in poolEvent.event) {
          auction_type = poolEvent.event.auctionType;
        } else {
          // New liquidation auction events do not have an auction type
          auction_type = AuctionType.Liquidation;
        }

        let user: string;

        // V1 interest auctions and bad debt auctions have no user
        if ('user' in poolEvent.event) {
          user = poolEvent.event.user;
        } else {
          user = poolConfig.backstopAddress;
        }
        // check if the auction should be bid on by an auctioneer
        let fillerFound = false;
        for (const filler of APP_CONFIG.fillers) {
          // check if filler should try and bid on the auction
          if (!canFillerBid(filler, poolEvent.event.auctionData)) {
            continue;
          }
          let auctionEntry: AuctionEntry = {
            pool_id: poolConfig.poolAddress,
            user_id: user,
            auction_type: auction_type,
            filler: filler.keypair.publicKey(),
            start_block: poolEvent.event.auctionData.block,
            fill_block: 0,
            updated: poolEvent.event.ledger,
          };
          this.db.setAuctionEntry(auctionEntry);

          const logMessage = `New auction\nType: ${AuctionType[auction_type]}\nFiller: ${filler.name}\nUser: ${user}\nAuction Data: ${stringify(poolEvent.event.auctionData, 2)}\n`;
          await sendSlackNotification(poolConfig, logMessage);
          logger.info(logMessage);
          fillerFound = true;
          break;
        }
        if (!fillerFound) {
          const logMessage = `Auction Ignored\n Type: ${AuctionType[auction_type]}\nUser: ${user}\nAuction Data: ${stringify(poolEvent.event.auctionData, 2)}\n`;
          await sendSlackNotification(poolConfig, logMessage);
          logger.info(logMessage);
        }
        break;
      }
      case PoolEventType.DeleteLiquidationAuction: {
        // user position is now healthy and user deleted their liquidation auction
        let runResult = this.db.deleteAuctionEntry(
          poolConfig.poolAddress,
          poolEvent.event.user,
          AuctionType.Liquidation
        );
        if (runResult.changes !== 0) {
          const logMessage = `Liquidation Auction Deleted\nUser: ${poolEvent.event.user}\n`;
          await sendSlackNotification(poolConfig, logMessage);
          logger.info(logMessage);
        }
        break;
      }
      case PoolEventType.FillAuction: {
        const fillerAddress =
          'from' in poolEvent.event ? poolEvent.event.from : poolEvent.event.filler;
        const logMessage = `Auction Fill Event\nType ${AuctionType[poolEvent.event.auctionType]}\nFiller: ${fillerAddress}\nUser: ${poolEvent.event.user}\nFill Percent: ${poolEvent.event.fillAmount}\nTx Hash: ${poolEvent.event.txHash}\n`;
        await sendSlackNotification(poolConfig, logMessage);
        logger.info(logMessage);
        if (poolEvent.event.fillAmount === BigInt(100)) {
          // auction was fully filled, remove from ongoing auctions
          let runResult = this.db.deleteAuctionEntry(
            poolConfig.poolAddress,
            poolEvent.event.user,
            poolEvent.event.auctionType
          );
          if (runResult.changes !== 0) {
            logger.info(
              `Auction Deleted\nType: ${AuctionType[poolEvent.event.auctionType]}\nUser: ${poolEvent.event.user}`
            );
          }
        }
        if (poolEvent.event.auctionType === AuctionType.Liquidation) {
          const { estimate: userPositionsEstimate, user } =
            await this.sorobanHelper.loadUserPositionEstimate(poolConfig, poolEvent.event.user);
          updateUser(this.db, pool, user, userPositionsEstimate, poolEvent.event.ledger);
          const { estimate: fillerPositionsEstimate, user: filler } =
            await this.sorobanHelper.loadUserPositionEstimate(poolConfig, fillerAddress);
          updateUser(this.db, pool, filler, fillerPositionsEstimate, poolEvent.event.ledger);
        } else if (poolEvent.event.auctionType === AuctionType.BadDebt) {
          const { estimate: fillerPositionsEstimate, user: filler } =
            await this.sorobanHelper.loadUserPositionEstimate(poolConfig, fillerAddress);
          updateUser(this.db, pool, filler, fillerPositionsEstimate, poolEvent.event.ledger);
          sendEvent(this.worker, {
            type: EventType.CHECK_USER,
            timestamp: Date.now(),
            poolConfig: poolConfig,
            userId: poolConfig.backstopAddress,
          });
        }
        break;
      }

      case PoolEventType.BadDebt: {
        // user has transferred bad debt to the backstop address
        const { estimate: userPositionsEstimate, user } =
          await this.sorobanHelper.loadUserPositionEstimate(poolConfig, poolEvent.event.user);
        updateUser(this.db, pool, user, userPositionsEstimate, poolEvent.event.ledger);
        sendEvent(this.worker, {
          type: EventType.CHECK_USER,
          timestamp: Date.now(),
          poolConfig: poolConfig,
          userId: poolConfig.backstopAddress,
        });
        break;
      }
      default: {
        logger.error(`Unhandled event type: ${poolEvent.event.eventType}`);
        break;
      }
    }
  }
}

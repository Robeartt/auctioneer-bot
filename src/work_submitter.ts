import {
  ContractError,
  ContractErrorType,
  FixedMath,
  PoolContractV1,
  PoolContractV2,
  Version,
} from '@blend-capital/blend-sdk';
import { APP_CONFIG, PoolConfig } from './utils/config.js';
import { AuctionType } from './utils/db.js';
import { serializeError, stringify } from './utils/json.js';
import { logger } from './utils/logger.js';
import { sendSlackNotification } from './utils/slack_notifier.js';
import { SorobanHelper } from './utils/soroban_helper.js';
import { SubmissionQueue } from './utils/submission_queue.js';

export type WorkSubmission = UserLiquidation | BadDebtTransfer | BadDebtAuction;

export enum WorkSubmissionType {
  LiquidateUser = 'liquidate',
  BadDebtTransfer = 'bad_debt_transfer',
  BadDebtAuction = 'bad_debt_auction',
}

export interface BaseWorkSubmission {
  type: WorkSubmissionType;
  poolConfig: PoolConfig;
}

export interface BadDebtTransfer extends BaseWorkSubmission {
  type: WorkSubmissionType.BadDebtTransfer;
  user: string;
}

export interface UserLiquidation extends BaseWorkSubmission {
  type: WorkSubmissionType.LiquidateUser;
  user: string;
  liquidationPercent: bigint;
}

export interface BadDebtAuction extends BaseWorkSubmission {
  type: WorkSubmissionType.BadDebtAuction;
}

export class WorkSubmitter extends SubmissionQueue<WorkSubmission> {
  constructor() {
    super();
  }

  // @dev: Return true to acknowledge the submission, or false to retry
  async submit(submission: WorkSubmission): Promise<boolean> {
    let sorobanHelper = new SorobanHelper();

    switch (submission.type) {
      case WorkSubmissionType.LiquidateUser:
        return this.submitUserLiquidation(sorobanHelper, submission);
      case WorkSubmissionType.BadDebtTransfer:
        return this.submitBadDebtTransfer(sorobanHelper, submission);
      case WorkSubmissionType.BadDebtAuction:
        return this.submitBadDebtAuction(sorobanHelper, submission);
      default:
        logger.error(`Invalid submission type: ${stringify(submission)}`);
        // consume the submission
        return true;
    }
  }

  async submitUserLiquidation(
    sorobanHelper: SorobanHelper,
    userLiquidation: UserLiquidation
  ): Promise<boolean> {
    try {
      logger.info(`Creating liquidation for user: ${userLiquidation.user}`);

      const pool = new PoolContractV1(userLiquidation.poolConfig.poolAddress);
      const op = pool.newLiquidationAuction({
        user: userLiquidation.user,
        percent_liquidated: userLiquidation.liquidationPercent,
      });

      const auctionExists =
        (await sorobanHelper.loadAuction(
          userLiquidation.poolConfig,
          userLiquidation.user,
          AuctionType.Liquidation
        )) !== undefined;
      if (auctionExists) {
        logger.info(`User liquidation auction already exists for user: ${userLiquidation.user}`);
        return true;
      }
      await sorobanHelper.submitTransaction(op, APP_CONFIG.keypair);
      const logMessage = `Successfully created liquidation for user: ${userLiquidation.user} Liquidation Percent: ${userLiquidation.liquidationPercent}`;
      logger.info(logMessage);
      await sendSlackNotification(userLiquidation.poolConfig, logMessage);
      return true;
    } catch (e: any) {
      // if pool throws a "LIQ_TOO_SMALL" or "LIQ_TOO_LARGE" error, adjust the fill percentage
      // by 1 percentage point before retrying.
      if (e instanceof ContractError) {
        if (
          e.type === ContractErrorType.InvalidLiqTooSmall &&
          userLiquidation.liquidationPercent < BigInt(100)
        ) {
          userLiquidation.liquidationPercent += BigInt(1);
        } else if (
          e.type === ContractErrorType.InvalidLiqTooLarge &&
          userLiquidation.liquidationPercent > BigInt(1)
        ) {
          userLiquidation.liquidationPercent -= BigInt(1);
        }
      }
      const logMessage =
        `Error creating user liquidation\n` +
        `User: ${userLiquidation.user}\n` +
        `Liquidation Percent: ${userLiquidation.liquidationPercent}`;
      logger.error(logMessage, e);
      await sendSlackNotification(
        userLiquidation.poolConfig,
        `<!channel> ` + logMessage + `\nError: ${stringify(serializeError(e))}`
      );
      return false;
    }
  }

  async submitBadDebtTransfer(
    sorobanHelper: SorobanHelper,
    badDebtTransfer: BadDebtTransfer
  ): Promise<boolean> {
    try {
      logger.info(`Transferring bad debt to backstop for user: ${badDebtTransfer.user}`);
      const pool = new PoolContractV1(badDebtTransfer.poolConfig.poolAddress);
      const op = pool.badDebt(badDebtTransfer.user);
      await sorobanHelper.submitTransaction(op, APP_CONFIG.keypair);
      const logMessage = `Successfully transferred bad debt to backstop for user: ${badDebtTransfer.user}`;
      await sendSlackNotification(badDebtTransfer.poolConfig, logMessage);
      logger.info(logMessage);
      return true;
    } catch (e: any) {
      const logMessage = `Error transfering bad debt\n` + `User: ${badDebtTransfer.user}`;
      logger.error(logMessage, e);
      await sendSlackNotification(
        badDebtTransfer.poolConfig,
        `<!channel> ` + logMessage + `\nError: ${stringify(serializeError(e))}`
      );
      return false;
    }
  }

  async submitBadDebtAuction(
    sorobanHelper: SorobanHelper,
    submission: BadDebtAuction
  ): Promise<boolean> {
    try {
      logger.info(`Creating bad debt auction`);

      const pool = new PoolContractV1(submission.poolConfig.poolAddress);
      const op = pool.newBadDebtAuction();

      const auctionExists =
        (await sorobanHelper.loadAuction(
          submission.poolConfig,
          APP_CONFIG.backstopAddress,
          AuctionType.BadDebt
        )) !== undefined;
      if (auctionExists) {
        logger.info(`Bad debt auction already exists`);
        return true;
      }
      await sorobanHelper.submitTransaction(op, APP_CONFIG.keypair);
      const logMessage = `Successfully created bad debt auction`;
      logger.info(logMessage);
      await sendSlackNotification(submission.poolConfig, logMessage);
      return true;
    } catch (e: any) {
      const logMessage = `Error creating bad debt auction\n` + `Error: ${e}\n`;
      logger.error(logMessage);
      await sendSlackNotification(
        submission.poolConfig,
        `<!channel> ` + logMessage + `\nError: ${stringify(serializeError(e))}`
      );
      return false;
    }
  }

  async onDrop(submission: WorkSubmission): Promise<void> {
    // TODO: Send slack alert for dropped submission
    let logMessage: string;
    switch (submission.type) {
      case WorkSubmissionType.LiquidateUser:
        logMessage = `Dropped liquidation for user: ${submission.user}`;
        break;
      case WorkSubmissionType.BadDebtTransfer:
        logMessage = `Dropped bad debt transfer for user: ${submission.user}`;
        break;
      case WorkSubmissionType.BadDebtAuction:
        logMessage = `Dropped bad debt auction`;
        break;
    }
    logger.error(logMessage);
    await sendSlackNotification(submission.poolConfig, logMessage);
  }
}

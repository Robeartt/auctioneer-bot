import {
  Auction,
  ContractError,
  ContractErrorType,
  FixedMath,
  Version,
} from '@blend-capital/blend-sdk';
import { Keypair } from '@stellar/stellar-sdk';
import { AppConfig, PoolConfig } from '../src/utils/config';
import { AuctionType } from '../src/utils/db';
import { logger } from '../src/utils/logger';
import { sendSlackNotification } from '../src/utils/slack_notifier';
import { SorobanHelper } from '../src/utils/soroban_helper';
import { WorkSubmission, WorkSubmissionType, WorkSubmitter } from '../src/work_submitter';
import { mockPool, USDC } from './helpers/mocks';

// Mock dependencies
jest.mock('../src/utils/db');
jest.mock('../src/utils/soroban_helper');
jest.mock('../src/utils/slack_notifier');
jest.mock('../src/utils/logger');
jest.mock('../src/utils/logger.js', () => ({
  logger: {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));
jest.mock('../src/utils/config.js', () => {
  let config: AppConfig = {} as AppConfig;
  return {
    APP_CONFIG: config,
  };
});

describe('WorkSubmitter', () => {
  let workSubmitter: WorkSubmitter;

  let mockedSorobanHelper = new SorobanHelper() as jest.Mocked<SorobanHelper>;
  let mockedSorobanHelperConstructor = SorobanHelper as jest.MockedClass<typeof SorobanHelper>;
  const mockedSendSlackNotif = sendSlackNotification as jest.MockedFunction<
    typeof sendSlackNotification
  >;
  const poolConfig: PoolConfig = {
    poolAddress: mockPool.id,
    backstopAddress: mockPool.metadata.backstop,
    version: Version.V1,
    minPrimaryCollateral: FixedMath.toFixed(100, 7),
    primaryAsset: USDC,
  };
  beforeEach(() => {
    jest.resetAllMocks();
    workSubmitter = new WorkSubmitter();
    mockedSorobanHelperConstructor.mockReturnValue(mockedSorobanHelper);
  });

  it('should submit a user liquidation successfully', async () => {
    mockedSorobanHelper.loadAuction.mockResolvedValue(undefined);

    const submission = {
      type: WorkSubmissionType.LiquidateUser,
      poolConfig,
      user: Keypair.random().publicKey(),
      liquidationPercent: BigInt(50),
      lot: [],
      bid: [],
    };

    const result = await workSubmitter.submit(submission);
    expect(result).toBe(true);
    expect(mockedSorobanHelper.loadAuction).toHaveBeenCalledWith(
      poolConfig,
      submission.user,
      AuctionType.Liquidation
    );
    expect(mockedSorobanHelper.submitTransaction).toHaveBeenCalled();
    expect(mockedSendSlackNotif).toHaveBeenCalled();
  });

  it('should not submit if auction already exists', async () => {
    mockedSorobanHelper.loadAuction.mockResolvedValue(
      new Auction('user1', AuctionType.Liquidation, {
        bid: new Map<string, bigint>([['USD', BigInt(123)]]),
        lot: new Map<string, bigint>([['USD', BigInt(456)]]),
        block: 500,
      })
    );

    const submission = {
      type: WorkSubmissionType.LiquidateUser,
      poolConfig,
      user: Keypair.random().publicKey(),
      liquidationPercent: BigInt(50),
      lot: [],
      bid: [],
    };

    const result = await workSubmitter.submit(submission);

    expect(result).toBe(true);
    expect(mockedSorobanHelper.submitTransaction).not.toHaveBeenCalled();
    expect(mockedSendSlackNotif).not.toHaveBeenCalled();
  });

  it('should adjust fill percentage up for user liquidation with error LIQ_TOO_SMALL', async () => {
    mockedSorobanHelper.loadAuction.mockResolvedValue(undefined);
    mockedSorobanHelper.submitTransaction.mockRejectedValue(
      new ContractError(ContractErrorType.InvalidLiqTooSmall)
    );

    const submission = {
      type: WorkSubmissionType.LiquidateUser,
      poolConfig,
      user: Keypair.random().publicKey(),
      liquidationPercent: BigInt(50),
      lot: [],
      bid: [],
    };

    const result = await workSubmitter.submit(submission);
    expect(result).toBe(false);
    expect(submission.liquidationPercent).toBe(BigInt(51));
    expect(logger.error).toHaveBeenCalled();
    expect(mockedSendSlackNotif).toHaveBeenCalled();
  });

  it('does not increase fill percentage past 100 for user liquidation with error LIQ_TOO_SMALL', async () => {
    mockedSorobanHelper.loadAuction.mockResolvedValue(undefined);
    mockedSorobanHelper.submitTransaction.mockRejectedValue(
      new ContractError(ContractErrorType.InvalidLiqTooSmall)
    );

    const submission = {
      type: WorkSubmissionType.LiquidateUser,
      poolConfig,
      user: Keypair.random().publicKey(),
      liquidationPercent: BigInt(100),
      lot: [],
      bid: [],
    };

    const result = await workSubmitter.submit(submission);
    expect(result).toBe(false);
    expect(submission.liquidationPercent).toBe(BigInt(100));
    expect(logger.error).toHaveBeenCalled();
    expect(mockedSendSlackNotif).toHaveBeenCalled();
  });

  it('should adjust fill percentage down for user liquidation with error LIQ_TOO_LARGE', async () => {
    mockedSorobanHelper.loadAuction.mockResolvedValue(undefined);
    mockedSorobanHelper.submitTransaction.mockRejectedValue(
      new ContractError(ContractErrorType.InvalidLiqTooLarge)
    );

    const submission = {
      type: WorkSubmissionType.LiquidateUser,
      poolConfig,
      user: Keypair.random().publicKey(),
      liquidationPercent: BigInt(50),
      lot: [],
      bid: [],
    };

    const result = await workSubmitter.submit(submission);
    expect(result).toBe(false);
    expect(submission.liquidationPercent).toBe(BigInt(49));
    expect(logger.error).toHaveBeenCalled();
    expect(mockedSendSlackNotif).toHaveBeenCalled();
  });

  it('does not increase fill percentage past below 1 for user liquidation with error LIQ_TOO_LARGE', async () => {
    mockedSorobanHelper.loadAuction.mockResolvedValue(undefined);
    mockedSorobanHelper.submitTransaction.mockRejectedValue(
      new ContractError(ContractErrorType.InvalidLiqTooLarge)
    );

    const submission = {
      type: WorkSubmissionType.LiquidateUser,
      poolConfig,
      user: Keypair.random().publicKey(),
      liquidationPercent: BigInt(1),
      lot: [],
      bid: [],
    };

    const result = await workSubmitter.submit(submission);
    expect(result).toBe(false);
    expect(submission.liquidationPercent).toBe(BigInt(1));
    expect(logger.error).toHaveBeenCalled();
    expect(mockedSendSlackNotif).toHaveBeenCalled();
  });

  it('does not adjust fill percentage for general error', async () => {
    mockedSorobanHelper.loadAuction.mockResolvedValue(undefined);
    mockedSorobanHelper.submitTransaction.mockRejectedValue(
      new ContractError(ContractErrorType.InvalidLiquidation)
    );

    const submission = {
      type: WorkSubmissionType.LiquidateUser,
      poolConfig,
      user: Keypair.random().publicKey(),
      liquidationPercent: BigInt(50),
      lot: [],
      bid: [],
    };

    const result = await workSubmitter.submit(submission);
    expect(result).toBe(false);
    expect(submission.liquidationPercent).toBe(BigInt(50));
    expect(logger.error).toHaveBeenCalled();
    expect(mockedSendSlackNotif).toHaveBeenCalled();
  });

  it('should adjust fill percentage based on contract error on each retry', async () => {
    mockedSorobanHelper.loadAuction.mockResolvedValue(undefined);
    mockedSorobanHelper.submitTransaction.mockRejectedValue(
      new ContractError(ContractErrorType.InvalidLiqTooSmall)
    );

    const submission = {
      type: WorkSubmissionType.LiquidateUser,
      poolConfig,
      user: Keypair.random().publicKey(),
      liquidationPercent: BigInt(50),
      lot: [],
      bid: [],
    };

    workSubmitter.addSubmission(submission, 3, 0);
    while (workSubmitter.processing) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // 3 retries plus the final increment before dropping
    expect(submission.liquidationPercent).toBe(BigInt(54));
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Dropped liquidation for user')
    );
  });

  it('should submit a bad debt transfer successfully', async () => {
    const submission: WorkSubmission = {
      type: WorkSubmissionType.BadDebtTransfer,
      poolConfig,
      user: Keypair.random().publicKey(),
    };

    const result = await workSubmitter.submit(submission);
    expect(result).toBe(true);
    expect(mockedSorobanHelper.submitTransaction).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalled();
    expect(sendSlackNotification).toHaveBeenCalled();
  });

  it('should submit a bad debt auction successfully', async () => {
    mockedSorobanHelper.loadAuction.mockResolvedValue(undefined);

    const submission: WorkSubmission = {
      type: WorkSubmissionType.BadDebtAuction,
      poolConfig,
      lot: [],
      bid: [],
    };
    const result = await workSubmitter.submit(submission);

    expect(result).toBe(true);
    expect(mockedSorobanHelper.submitTransaction).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalled();
    expect(sendSlackNotification).toHaveBeenCalled();
  });

  it('should not submit if auction already exists', async () => {
    mockedSorobanHelper.loadAuction.mockResolvedValue(
      new Auction('user1', AuctionType.Liquidation, {
        bid: new Map<string, bigint>([['USD', BigInt(123)]]),
        lot: new Map<string, bigint>([['USD', BigInt(456)]]),
        block: 500,
      })
    );

    const submission: WorkSubmission = {
      type: WorkSubmissionType.BadDebtAuction,
      poolConfig,
      lot: [],
      bid: [],
    };
    const result = await workSubmitter.submit(submission);

    expect(result).toBe(true);
    expect(mockedSorobanHelper.submitTransaction).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalled();
  });

  it('should log an error when a liquidation is dropped', () => {
    const submission = {
      type: WorkSubmissionType.LiquidateUser,
      poolConfig,
      user: Keypair.random().publicKey(),
      liquidationPercent: BigInt(50),
      lot: [],
      bid: [],
    };
    workSubmitter.onDrop(submission);

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Dropped liquidation for user')
    );
  });

  it('should log an error when a bad debt transfer is dropped', () => {
    const submission: WorkSubmission = {
      type: WorkSubmissionType.BadDebtTransfer,
      poolConfig,
      user: Keypair.random().publicKey(),
    };

    workSubmitter.onDrop(submission);

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Dropped bad debt transfer for user')
    );
  });

  it('should log an error when a bad debt auction is dropped', () => {
    const submission: WorkSubmission = {
      type: WorkSubmissionType.BadDebtAuction,
      poolConfig,
      lot: [],
      bid: [],
    };

    workSubmitter.onDrop(submission);

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Dropped bad debt auction'));
  });
});

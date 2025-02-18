import { Auction, PoolUser, Positions, PositionsEstimate } from '@blend-capital/blend-sdk';
import { Keypair } from '@stellar/stellar-sdk';
import {
  calculateLiquidationPercent,
  checkUsersForLiquidationsAndBadDebt,
  isBadDebt,
  isLiquidatable,
  scanUsers,
} from '../src/liquidations';
import { APP_CONFIG } from '../src/utils/config.js';
import { AuctioneerDatabase } from '../src/utils/db.js';
import { PoolUserEst, SorobanHelper } from '../src/utils/soroban_helper.js';
import { WorkSubmissionType } from '../src/work_submitter.js';
import { inMemoryAuctioneerDb, mockPool, USDC, USDC_ID, XLM, XLM_ID } from './helpers/mocks.js';

jest.mock('../src/utils/soroban_helper.js');
jest.mock('../src/utils/logger.js', () => ({
  logger: {
    error: jest.fn(),
    info: jest.fn(),
  },
}));
jest.mock('../src/utils/config.js', () => {
  return {
    APP_CONFIG: {
      backstopAddress: 'backstopAddress',
    },
  };
});
jest.mock('../src/user.js', () => {
  return {
    updateUser: jest.fn(),
  };
});

describe('isLiquidatable', () => {
  let userEstimate: PositionsEstimate;

  beforeEach(() => {
    userEstimate = new PositionsEstimate(0, 0, 0, 0, 0, 0, 0, 0, 0);
  });

  it('returns true if the userEstimate health factor is lt .998', async () => {
    userEstimate.totalEffectiveCollateral = 1000;
    userEstimate.totalEffectiveLiabilities = 1003;
    const result = isLiquidatable(userEstimate);
    expect(result).toBe(true);
  });

  it('returns false if the userEstimate health facotr is gte to .998', async () => {
    userEstimate.totalEffectiveCollateral = 1000;
    userEstimate.totalEffectiveLiabilities = 1002;
    const result = isLiquidatable(userEstimate);
    expect(result).toBe(false);
  });
});

describe('isBadDebt', () => {
  let userEstimate: PositionsEstimate;

  beforeEach(() => {
    userEstimate = new PositionsEstimate(0, 0, 0, 0, 0, 0, 0, 0, 0);
  });
  it('should return true when totalEffectiveCollateral is 0 and totalEffectiveLiabilities is greater than 0', () => {
    userEstimate.totalEffectiveCollateral = 0;
    userEstimate.totalEffectiveLiabilities = 100;
    expect(isBadDebt(userEstimate)).toBe(true);
  });

  it('should return false when totalEffectiveCollateral is greater than 0 and totalEffectiveLiabilities is greater than 0', () => {
    userEstimate.totalEffectiveCollateral = 100;
    userEstimate.totalEffectiveLiabilities = 100;
    expect(isBadDebt(userEstimate)).toBe(false);
  });

  it('should return false when totalEffectiveCollateral is 0 and totalEffectiveLiabilities is 0', () => {
    userEstimate.totalEffectiveCollateral = 0;
    userEstimate.totalEffectiveLiabilities = 0;
    expect(isBadDebt(userEstimate)).toBe(false);
  });

  it('should return false when totalEffectiveCollateral is greater than 0 and totalEffectiveLiabilities is 0', () => {
    userEstimate.totalEffectiveCollateral = 100;
    userEstimate.totalEffectiveLiabilities = 0;
    expect(isBadDebt(userEstimate)).toBe(false);
  });
});

describe('calculateLiquidationPercent', () => {
  let userEstimate: PositionsEstimate;

  beforeEach(() => {
    userEstimate = new PositionsEstimate(0, 0, 0, 0, 0, 0, 0, 0, 0);
  });
  it('should calculate the correct liquidation percent for typical values', () => {
    userEstimate.totalEffectiveCollateral = 1000;
    userEstimate.totalEffectiveLiabilities = 1100;
    userEstimate.totalBorrowed = 1500;
    userEstimate.totalSupplied = 2000;
    const result = calculateLiquidationPercent(userEstimate);
    expect(Number(result)).toBe(56);
  });

  it('should calculate max of 100 percent liquidation size', () => {
    userEstimate.totalEffectiveCollateral = 1700;
    userEstimate.totalEffectiveLiabilities = 2200;
    userEstimate.totalBorrowed = 1900;
    userEstimate.totalSupplied = 2000;
    const result = calculateLiquidationPercent(userEstimate);

    expect(Number(result)).toBe(100);
  });

  it('should calculate the smallest possible liquidation size', () => {
    userEstimate.totalEffectiveCollateral = 2199;
    userEstimate.totalEffectiveLiabilities = 2200;
    userEstimate.totalBorrowed = 1900;
    userEstimate.totalSupplied = 10000000000000;
    const result = calculateLiquidationPercent(userEstimate);

    expect(Number(result)).toBe(6);
  });
});

describe('scanUsers', () => {
  let db: AuctioneerDatabase;
  let mockedSorobanHelper: jest.Mocked<SorobanHelper>;
  let mockBackstopPositions: PoolUser;
  let mockBackstopPositionsEstimate: PositionsEstimate;
  let mockPoolUserEstimate: PositionsEstimate;
  let mockPoolUser: PoolUser;
  beforeEach(() => {
    db = inMemoryAuctioneerDb();
    mockedSorobanHelper = new SorobanHelper() as jest.Mocked<SorobanHelper>;
    mockedSorobanHelper.loadPool.mockResolvedValue(mockPool);
    mockBackstopPositions = new PoolUser(
      'backstopAddress',
      new Positions(new Map(), new Map(), new Map()),
      new Map()
    );
    mockBackstopPositionsEstimate = new PositionsEstimate(0, 0, 0, 0, 0, 0, 0, 0, 0);
    mockPoolUserEstimate = new PositionsEstimate(0, 0, 0, 0, 0, 0, 0, 0, 0);
    mockPoolUser = new PoolUser(
      Keypair.random().publicKey(),
      new Positions(new Map(), new Map(), new Map()),
      new Map()
    );
  });

  it('should create a work submission for liquidatable users', async () => {
    mockPoolUserEstimate.totalEffectiveCollateral = 1000;
    mockPoolUserEstimate.totalEffectiveLiabilities = 1100;
    mockPoolUserEstimate.totalBorrowed = 1500;
    mockPoolUserEstimate.totalSupplied = 2000;
    db.setUserEntry({
      user_id: mockPoolUser.userId,
      health_factor:
        mockPoolUserEstimate.totalEffectiveCollateral /
        mockPoolUserEstimate.totalEffectiveLiabilities,
      collateral: new Map(),
      liabilities: new Map(),
      updated: 123,
    });
    mockedSorobanHelper.loadUserPositionEstimate.mockImplementation((address: string) => {
      if (address === mockPoolUser.userId) {
        return Promise.resolve({
          estimate: mockPoolUserEstimate,
          user: mockPoolUser,
        } as PoolUserEst);
      } else if (address === 'backstopAddress') {
        return Promise.resolve({
          estimate: mockBackstopPositionsEstimate,
          user: mockBackstopPositions,
        } as PoolUserEst);
      }
      return Promise.resolve({ estimate: {}, user: {} } as PoolUserEst);
    });
    mockedSorobanHelper.loadAuction.mockResolvedValue(undefined);

    let liquidations = await scanUsers(db, mockedSorobanHelper);
    expect(liquidations.length).toBe(1);
  });

  it('should not create a work submission for users with existing liquidation auctions', async () => {
    mockPoolUserEstimate.totalEffectiveCollateral = 1000;
    mockPoolUserEstimate.totalEffectiveLiabilities = 1100;
    mockPoolUserEstimate.totalBorrowed = 1500;
    mockPoolUserEstimate.totalSupplied = 2000;
    db.setUserEntry({
      user_id: mockPoolUser.userId,
      health_factor:
        mockPoolUserEstimate.totalEffectiveCollateral /
        mockPoolUserEstimate.totalEffectiveLiabilities,
      collateral: new Map(),
      liabilities: new Map(),
      updated: 123,
    });
    mockedSorobanHelper.loadUserPositionEstimate.mockImplementation((address: string) => {
      if (address === mockPoolUser.userId) {
        return Promise.resolve({
          estimate: mockPoolUserEstimate,
          user: mockPoolUser,
        } as PoolUserEst);
      } else if (address === 'backstopAddress') {
        return Promise.resolve({
          estimate: mockBackstopPositionsEstimate,
          user: mockBackstopPositions,
        } as PoolUserEst);
      }
      return Promise.resolve({ estimate: {}, user: {} } as PoolUserEst);
    });
    mockedSorobanHelper.loadAuction.mockResolvedValue({ user: 'exists' } as Auction);

    let liquidations = await scanUsers(db, mockedSorobanHelper);
    expect(liquidations.length).toBe(0);
  });

  it('Checks backstop for bad debt when no users exist', async () => {
    mockBackstopPositionsEstimate.totalEffectiveLiabilities = 1000;
    mockBackstopPositionsEstimate.totalEffectiveCollateral = 0;
    mockedSorobanHelper.loadUserPositionEstimate.mockImplementation((address: string) => {
      if (address === mockPoolUser.userId) {
        return Promise.resolve({
          estimate: mockPoolUserEstimate,
          user: mockPoolUser,
        } as PoolUserEst);
      } else if (address === 'backstopAddress') {
        return Promise.resolve({
          estimate: mockBackstopPositionsEstimate,
          user: mockBackstopPositions,
        } as PoolUserEst);
      }
      return Promise.resolve({ estimate: {}, user: {} } as PoolUserEst);
    });

    let liquidations = await scanUsers(db, mockedSorobanHelper);
    expect(liquidations.length).toBe(1);
  });
});

describe('checkUsersForLiquidationsAndBadDebt', () => {
  let db: AuctioneerDatabase;
  let mockedSorobanHelper: jest.Mocked<SorobanHelper>;
  let mockBackstopPositions: PoolUser;
  let mockBackstopPositionsEstimate: PositionsEstimate;
  let mockUser: PoolUser;
  let mockUserEstimate: PositionsEstimate;

  beforeEach(() => {
    db = inMemoryAuctioneerDb();
    mockedSorobanHelper = new SorobanHelper() as jest.Mocked<SorobanHelper>;
    mockedSorobanHelper.loadPool.mockResolvedValue(mockPool);
    mockBackstopPositions = new PoolUser(
      'backstopAddress',
      new Positions(new Map(), new Map(), new Map()),
      new Map()
    );
    mockBackstopPositionsEstimate = new PositionsEstimate(0, 0, 0, 0, 0, 0, 0, 0, 0);
    mockUserEstimate = new PositionsEstimate(0, 0, 0, 0, 0, 0, 0, 0, 0);
    mockUser = new PoolUser(
      Keypair.random().publicKey(),
      new Positions(new Map(), new Map(), new Map()),
      new Map()
    );
  });

  it('should return an empty array when user_ids is empty', async () => {
    const result = await checkUsersForLiquidationsAndBadDebt(db, mockedSorobanHelper, []);
    expect(result).toEqual([]);
  });

  it('should handle backstop address user correctly', async () => {
    const user_ids = [APP_CONFIG.backstopAddress];
    mockedSorobanHelper.loadPool.mockResolvedValue(mockPool);
    mockBackstopPositionsEstimate.totalEffectiveLiabilities = 1000;
    mockBackstopPositionsEstimate.totalEffectiveCollateral = 0;
    mockBackstopPositions.positions = new Positions(
      new Map([[USDC_ID, 2000n]]),
      new Map([[XLM_ID, 3000n]]),
      new Map()
    );
    mockedSorobanHelper.loadUserPositionEstimate.mockResolvedValue({
      estimate: mockBackstopPositionsEstimate,
      user: mockBackstopPositions,
    });
    mockedSorobanHelper.loadAuction.mockResolvedValue(undefined);

    const result = await checkUsersForLiquidationsAndBadDebt(db, mockedSorobanHelper, user_ids);

    expect(result).toEqual([
      {
        type: WorkSubmissionType.BadDebtAuction,
        lot: [XLM],
        bid: [USDC],
      },
    ]);
  });

  it('should handle liquidatable users correctly', async () => {
    const user_ids = ['user1'];
    mockedSorobanHelper.loadPool.mockResolvedValue(mockPool);
    mockUserEstimate.totalEffectiveCollateral = 1000;
    mockUserEstimate.totalEffectiveLiabilities = 1100;
    mockUserEstimate.totalBorrowed = 1500;
    mockUserEstimate.totalSupplied = 2000;
    mockUser.positions = new Positions(
      new Map([[USDC_ID, 2000n]]),
      new Map([[XLM_ID, 3000n]]),
      new Map()
    );
    mockedSorobanHelper.loadUserPositionEstimate.mockResolvedValue({
      estimate: mockUserEstimate,
      user: mockUser,
    });
    mockedSorobanHelper.loadAuction.mockResolvedValue(undefined);

    const result = await checkUsersForLiquidationsAndBadDebt(db, mockedSorobanHelper, user_ids);

    expect(result.length).toBe(1);
    expect(result).toEqual([
      {
        type: WorkSubmissionType.LiquidateUser,
        user: 'user1',
        liquidationPercent: 56n,
        lot: [XLM],
        bid: [USDC],
      },
    ]);
  });

  it('should handle users with bad debt correctly', async () => {
    const user_ids = ['user1'];
    mockedSorobanHelper.loadPool.mockResolvedValue(mockPool);
    mockUserEstimate.totalEffectiveCollateral = 0;
    mockUserEstimate.totalEffectiveLiabilities = 1100;
    mockedSorobanHelper.loadUserPositionEstimate.mockResolvedValue({
      estimate: mockUserEstimate,
      user: mockUser,
    });
    mockedSorobanHelper.loadAuction.mockResolvedValue(undefined);

    const result = await checkUsersForLiquidationsAndBadDebt(db, mockedSorobanHelper, user_ids);

    expect(result.length).toBe(1);
    expect(result).toEqual([{ type: WorkSubmissionType.BadDebtTransfer, user: 'user1' }]);
  });
});

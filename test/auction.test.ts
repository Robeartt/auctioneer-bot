import {
  Auction,
  AuctionType,
  BackstopToken,
  FixedMath,
  PoolUser,
  PositionsEstimate,
  Request,
} from '@blend-capital/blend-sdk';
import { Keypair } from '@stellar/stellar-sdk';
import { calculateAuctionFill, valueBackstopTokenInUSDC } from '../src/auction.js';
import { getFillerAvailableBalances, getFillerProfitPct } from '../src/filler.js';
import { Filler } from '../src/utils/config.js';
import { AuctioneerDatabase } from '../src/utils/db.js';
import { SorobanHelper } from '../src/utils/soroban_helper.js';
import {
  AQUA,
  BACKSTOP,
  BACKSTOP_TOKEN,
  EURC,
  inMemoryAuctioneerDb,
  MOCK_LEDGER,
  MOCK_TIMESTAMP,
  mockPool,
  mockPoolOracle,
  USDC,
  XLM,
} from './helpers/mocks.js';
import { expectRelApproxEqual } from './helpers/utils.js';

jest.mock('../src/utils/soroban_helper.js');
jest.mock('../src/filler.js');
jest.mock('../src/utils/config.js', () => {
  return {
    APP_CONFIG: {
      rpcURL: 'http://localhost:8000/rpc',
      networkPassphrase: 'Public Global Stellar Network ; September 2015',
      poolAddress: 'CBP7NO6F7FRDHSOFQBT2L2UWYIZ2PU76JKVRYAQTG3KZSQLYAOKIF2WB',
      backstopAddress: 'CAO3AGAMZVRMHITL36EJ2VZQWKYRPWMQAPDQD5YEOF3GIF7T44U4JAL3',
      backstopTokenAddress: 'CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM',
      usdcAddress: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
      blndAddress: 'CD25MNVTZDL4Y3XBCPCJXGXATV5WUHHOWMYFF4YBEGU5FCPGMYTVG5JY',
      keypair: '',
      fillers: [],
    },
  };
});

describe('auctions', () => {
  let filler: Filler;
  const mockedSorobanHelper = new SorobanHelper() as jest.Mocked<SorobanHelper>;
  let db: AuctioneerDatabase;
  let positionEstimate: PositionsEstimate;

  const mockedGetFilledAvailableBalances = getFillerAvailableBalances as jest.MockedFunction<
    typeof getFillerAvailableBalances
  >;
  const mockedGetFillerProfitPct = getFillerProfitPct as jest.MockedFunction<
    typeof getFillerProfitPct
  >;

  beforeEach(() => {
    jest.resetAllMocks();
    db = inMemoryAuctioneerDb();
    filler = {
      name: 'Tester',
      keypair: Keypair.random(),
      defaultProfitPct: 0.1,
      minHealthFactor: 1.2,
      primaryAsset: USDC,
      minPrimaryCollateral: 0n,
      forceFill: true,
      supportedBid: [],
      supportedLot: [],
    };
    positionEstimate = {
      totalBorrowed: 0,
      totalSupplied: 0,
      // only effective numbers used
      totalEffectiveLiabilities: 0,
      totalEffectiveCollateral: 4750,
      borrowCap: 0,
      borrowLimit: 0,
      netApr: 0,
      supplyApr: 0,
      borrowApr: 0,
    };
    mockedSorobanHelper.loadPool.mockResolvedValue(mockPool);
    mockedSorobanHelper.loadPoolOracle.mockResolvedValue(mockPoolOracle);
    mockedSorobanHelper.loadUserPositionEstimate.mockResolvedValue({
      estimate: positionEstimate,
      user: {} as PoolUser,
    });
    mockedSorobanHelper.simLPTokenToUSDC.mockImplementation((number: bigint) => {
      // 0.5 USDC per LP token
      return Promise.resolve((number * 5000000n) / 10000000n);
    });
  });

  describe('calcAuctionFill', () => {
    // *** Interest Auctions ***

    it('calcs fill for interest auction', async () => {
      let nextLedger = MOCK_LEDGER + 1;
      let auction = new Auction(BACKSTOP, AuctionType.Interest, {
        lot: new Map<string, bigint>([
          [XLM, FixedMath.toFixed(120)],
          [USDC, FixedMath.toFixed(210)],
          [EURC, FixedMath.toFixed(34)],
          [AQUA, FixedMath.toFixed(2500)],
        ]),
        bid: new Map<string, bigint>([[BACKSTOP_TOKEN, FixedMath.toFixed(728.01456)]]),
        block: MOCK_LEDGER,
      });

      mockedGetFillerProfitPct.mockReturnValue(0.1);
      mockedGetFilledAvailableBalances.mockResolvedValue(
        new Map<string, bigint>([[BACKSTOP_TOKEN, FixedMath.toFixed(1000)]])
      );

      let fill = await calculateAuctionFill(filler, auction, nextLedger, mockedSorobanHelper, db);

      let expectedRequests: Request[] = [
        {
          request_type: 8,
          address: BACKSTOP,
          amount: 100n,
        },
      ];
      expect(fill.block).toEqual(MOCK_LEDGER + 272);
      expect(fill.percent).toEqual(100);
      expect(fill.requests).toEqual(expectedRequests);
      expectRelApproxEqual(fill.lotValue, 260.5722, 0.005);
      expectRelApproxEqual(fill.bidValue, 233.4726912, 0.005);

      expect(mockedGetFilledAvailableBalances).toHaveBeenCalledWith(
        filler,
        [BACKSTOP_TOKEN],
        mockedSorobanHelper
      );
    });

    it('calcs fill for interest auction and delays block to fully fill', async () => {
      let nextLedger = MOCK_LEDGER + 1;
      let auction = new Auction(BACKSTOP, AuctionType.Interest, {
        lot: new Map<string, bigint>([
          [XLM, FixedMath.toFixed(120)],
          [USDC, FixedMath.toFixed(210)],
          [EURC, FixedMath.toFixed(34)],
          [AQUA, FixedMath.toFixed(2500)],
        ]),
        bid: new Map<string, bigint>([[BACKSTOP_TOKEN, FixedMath.toFixed(728.01456)]]),
        block: MOCK_LEDGER,
      });

      mockedGetFillerProfitPct.mockReturnValue(0.1);
      mockedGetFilledAvailableBalances.mockResolvedValue(
        new Map<string, bigint>([[BACKSTOP_TOKEN, FixedMath.toFixed(400)]])
      );

      let fill = await calculateAuctionFill(filler, auction, nextLedger, mockedSorobanHelper, db);

      let expectedRequests: Request[] = [
        {
          request_type: 8,
          address: BACKSTOP,
          amount: 100n,
        },
      ];
      expect(fill.block).toEqual(MOCK_LEDGER + 272 + 19);
      expect(fill.percent).toEqual(100);
      expect(fill.requests).toEqual(expectedRequests);
      expectRelApproxEqual(fill.lotValue, 260.5722, 0.005);
      expectRelApproxEqual(fill.bidValue, 198.8165886, 0.005);
    });

    it('calcs fill for interest auction at next ledger if past target block', async () => {
      let nextLedger = MOCK_LEDGER + 280;
      let auction = new Auction(BACKSTOP, AuctionType.Interest, {
        lot: new Map<string, bigint>([
          [XLM, FixedMath.toFixed(120)],
          [USDC, FixedMath.toFixed(210)],
          [EURC, FixedMath.toFixed(34)],
          [AQUA, FixedMath.toFixed(2500)],
        ]),
        bid: new Map<string, bigint>([[BACKSTOP_TOKEN, FixedMath.toFixed(728.01456)]]),
        block: MOCK_LEDGER,
      });

      mockedGetFillerProfitPct.mockReturnValue(0.1);
      mockedGetFilledAvailableBalances.mockResolvedValue(
        new Map<string, bigint>([[BACKSTOP_TOKEN, FixedMath.toFixed(1000)]])
      );

      let fill = await calculateAuctionFill(filler, auction, nextLedger, mockedSorobanHelper, db);

      let expectedRequests: Request[] = [
        {
          request_type: 8,
          address: BACKSTOP,
          amount: 100n,
        },
      ];
      expect(fill.block).toEqual(nextLedger);
      expect(fill.percent).toEqual(100);
      expect(fill.requests).toEqual(expectedRequests);
      expectRelApproxEqual(fill.lotValue, 260.5722, 0.005);
      expectRelApproxEqual(fill.bidValue, 218.880648, 0.005);
    });

    it('calcs fill for interest auction uses db prices when possible', async () => {
      let nextLedger = MOCK_LEDGER + 1;
      let auction = new Auction(BACKSTOP, AuctionType.Interest, {
        lot: new Map<string, bigint>([
          [XLM, FixedMath.toFixed(120)],
          [USDC, FixedMath.toFixed(210)],
          [EURC, FixedMath.toFixed(34)],
          [AQUA, FixedMath.toFixed(2500)],
        ]),
        bid: new Map<string, bigint>([[BACKSTOP_TOKEN, FixedMath.toFixed(728.01456)]]),
        block: MOCK_LEDGER,
      });

      db.setPriceEntries([
        {
          asset_id: XLM,
          price: 0.3,
          timestamp: MOCK_TIMESTAMP - 100,
        },
      ]);

      mockedGetFillerProfitPct.mockReturnValue(0.1);
      mockedGetFilledAvailableBalances.mockResolvedValue(
        new Map<string, bigint>([[BACKSTOP_TOKEN, FixedMath.toFixed(1000)]])
      );

      let fill = await calculateAuctionFill(filler, auction, nextLedger, mockedSorobanHelper, db);

      let expectedRequests: Request[] = [
        {
          request_type: 8,
          address: BACKSTOP,
          amount: 100n,
        },
      ];
      expect(fill.block).toEqual(MOCK_LEDGER + 260);
      expect(fill.percent).toEqual(100);
      expect(fill.requests).toEqual(expectedRequests);
      expectRelApproxEqual(fill.lotValue, 284.6922, 0.005);
      expectRelApproxEqual(fill.bidValue, 254.805096, 0.005);
    });

    it('calcs fill for interest auction respects force fill setting', async () => {
      let nextLedger = MOCK_LEDGER + 1;
      let auction = new Auction(BACKSTOP, AuctionType.Interest, {
        lot: new Map<string, bigint>([
          [XLM, FixedMath.toFixed(120)],
          [USDC, FixedMath.toFixed(210)],
          [EURC, FixedMath.toFixed(34)],
          [AQUA, FixedMath.toFixed(2500)],
        ]),
        bid: new Map<string, bigint>([[BACKSTOP_TOKEN, FixedMath.toFixed(2500)]]),
        block: MOCK_LEDGER,
      });

      mockedGetFillerProfitPct.mockReturnValue(0.2);
      mockedGetFilledAvailableBalances.mockResolvedValue(
        new Map<string, bigint>([[BACKSTOP_TOKEN, FixedMath.toFixed(1000)]])
      );

      filler.forceFill = true;
      let fill_force = await calculateAuctionFill(
        filler,
        auction,
        nextLedger,
        mockedSorobanHelper,
        db
      );

      filler.forceFill = false;
      let fill_no_force = await calculateAuctionFill(
        filler,
        auction,
        nextLedger,
        mockedSorobanHelper,
        db
      );

      let expectedRequests: Request[] = [
        {
          request_type: 8,
          address: BACKSTOP,
          amount: 100n,
        },
      ];
      expect(fill_force.block).toEqual(MOCK_LEDGER + 350);
      expect(fill_force.percent).toEqual(100);
      expect(fill_force.requests).toEqual(expectedRequests);
      expectRelApproxEqual(fill_force.lotValue, 260.5722, 0.005);
      expectRelApproxEqual(fill_force.bidValue, 312.5, 0.005);

      expect(fill_no_force.block).toEqual(MOCK_LEDGER + 367);
      expect(fill_no_force.percent).toEqual(100);
      expect(fill_no_force.requests).toEqual(expectedRequests);
      expectRelApproxEqual(fill_no_force.lotValue, 260.5722, 0.005);
      expectRelApproxEqual(fill_no_force.bidValue, 206.25, 0.005);
    });

    // *** Liquidation Auctions ***

    it('calcs fill for liquidation auction', async () => {
      let user = Keypair.random().publicKey();
      let nextLedger = MOCK_LEDGER + 1;
      let auction = new Auction(user, AuctionType.Liquidation, {
        lot: new Map<string, bigint>([
          [USDC, FixedMath.toFixed(15.93)],
          [EURC, FixedMath.toFixed(16.211)],
        ]),
        bid: new Map<string, bigint>([[XLM, FixedMath.toFixed(300.21)]]),
        block: MOCK_LEDGER,
      });
      positionEstimate.totalEffectiveLiabilities = 0;
      positionEstimate.totalEffectiveCollateral = 1000;

      mockedSorobanHelper.loadUserPositionEstimate.mockResolvedValue({
        user: {} as PoolUser,
        estimate: positionEstimate,
      });
      mockedGetFillerProfitPct.mockReturnValue(0.1);
      mockedGetFilledAvailableBalances.mockResolvedValue(
        new Map<string, bigint>([[USDC, FixedMath.toFixed(100)]])
      );

      let fill = await calculateAuctionFill(filler, auction, nextLedger, mockedSorobanHelper, db);

      let expectedRequests: Request[] = [
        {
          request_type: 6,
          address: user,
          amount: 100n,
        },
      ];
      expect(fill.block).toEqual(MOCK_LEDGER + 194);
      expect(fill.percent).toEqual(100);
      expect(fill.requests).toEqual(expectedRequests);
      expectRelApproxEqual(fill.lotValue, 32.8213, 0.005);
      expectRelApproxEqual(fill.bidValue, 29.73769976, 0.005);

      expect(mockedGetFilledAvailableBalances).toHaveBeenCalledWith(
        filler,
        [USDC, EURC, XLM],
        mockedSorobanHelper
      );
    });

    it('calcs fill for liquidation auction and repays incoming liabilties and withdraws 0 CF collateral', async () => {
      let user = Keypair.random().publicKey();
      let nextLedger = MOCK_LEDGER + 1;
      let auction = new Auction(user, AuctionType.Liquidation, {
        lot: new Map<string, bigint>([
          [USDC, FixedMath.toFixed(15.93)],
          [EURC, FixedMath.toFixed(16.211)],
          [AQUA, FixedMath.toFixed(750)],
        ]),
        bid: new Map<string, bigint>([[XLM, FixedMath.toFixed(300.21)]]),
        block: MOCK_LEDGER,
      });
      positionEstimate.totalEffectiveLiabilities = 0;
      positionEstimate.totalEffectiveCollateral = 1000;

      mockedSorobanHelper.loadUserPositionEstimate.mockResolvedValue({
        user: {} as PoolUser,
        estimate: positionEstimate,
      });
      mockedGetFillerProfitPct.mockReturnValue(0.1);
      mockedGetFilledAvailableBalances.mockResolvedValue(
        new Map<string, bigint>([
          [USDC, FixedMath.toFixed(100)],
          [XLM, FixedMath.toFixed(500)],
        ])
      );

      let fill = await calculateAuctionFill(filler, auction, nextLedger, mockedSorobanHelper, db);

      let expectedRequests: Request[] = [
        {
          request_type: 6,
          address: user,
          amount: 100n,
        },
        {
          request_type: 5,
          address: XLM,
          amount: 3003808157n,
        },
        {
          request_type: 3,
          address: AQUA,
          amount: BigInt('9223372036854775807'),
        },
      ];
      expect(fill.block).toEqual(MOCK_LEDGER + 191);
      expect(fill.percent).toEqual(100);
      expect(fill.requests).toEqual(expectedRequests);
      expectRelApproxEqual(fill.lotValue, 32.7722, 0.005);
      expectRelApproxEqual(fill.bidValue, 29.73769976, 0.005);
    });

    it('calcs fill for liquidation auction adds primary collateral', async () => {
      let user = Keypair.random().publicKey();
      let nextLedger = MOCK_LEDGER + 186;
      let auction = new Auction(user, AuctionType.Liquidation, {
        lot: new Map<string, bigint>([[XLM, FixedMath.toFixed(100000)]]),
        bid: new Map<string, bigint>([
          [USDC, FixedMath.toFixed(100)],
          [EURC, FixedMath.toFixed(7500)],
        ]),
        block: MOCK_LEDGER,
      });
      positionEstimate.totalEffectiveLiabilities = 0;
      positionEstimate.totalEffectiveCollateral = 1000;

      mockedSorobanHelper.loadUserPositionEstimate.mockResolvedValue({
        user: {} as PoolUser,
        estimate: positionEstimate,
      });
      mockedGetFillerProfitPct.mockReturnValue(0.1);
      mockedGetFilledAvailableBalances.mockResolvedValue(
        new Map<string, bigint>([
          [USDC, FixedMath.toFixed(5000)],
          [XLM, FixedMath.toFixed(500)],
        ])
      );

      filler.primaryAsset = USDC;
      let fill = await calculateAuctionFill(filler, auction, nextLedger, mockedSorobanHelper, db);

      let expectedRequests: Request[] = [
        {
          request_type: 6,
          address: user,
          amount: 100n,
        },
        // repays any incoming primary liabilities first
        {
          request_type: 5,
          address: USDC,
          amount: 101_0182653n,
        },
        // adds additional primary collateral to reach min HF
        {
          request_type: 2,
          address: USDC,
          amount: FixedMath.toFixed(4420),
        },
      ];
      expect(fill.block).toEqual(MOCK_LEDGER + 187);
      expect(fill.percent).toEqual(100);
      expect(fill.requests).toEqual(expectedRequests);
      expectRelApproxEqual(fill.lotValue, 9257.3115, 0.005);
      expectRelApproxEqual(fill.bidValue, 8378.033243, 0.005);
    });

    it('calcs fill for liquidation auction scales fill percent down', async () => {
      let user = Keypair.random().publicKey();
      let nextLedger = MOCK_LEDGER + 188;
      let auction = new Auction(user, AuctionType.Liquidation, {
        lot: new Map<string, bigint>([[XLM, FixedMath.toFixed(100000)]]),
        bid: new Map<string, bigint>([[XLM, FixedMath.toFixed(85000)]]),
        block: MOCK_LEDGER,
      });
      positionEstimate.totalEffectiveLiabilities = 0;
      positionEstimate.totalEffectiveCollateral = 1000;

      mockedSorobanHelper.loadUserPositionEstimate.mockResolvedValue({
        user: {} as PoolUser,
        estimate: positionEstimate,
      });
      mockedGetFillerProfitPct.mockReturnValue(0.1);
      mockedGetFilledAvailableBalances.mockResolvedValue(new Map<string, bigint>([]));

      filler.primaryAsset = USDC;
      let fill = await calculateAuctionFill(filler, auction, nextLedger, mockedSorobanHelper, db);

      let expectedRequests: Request[] = [
        {
          request_type: 6,
          address: user,
          amount: 12n,
        },
      ];
      expect(fill.block).toEqual(MOCK_LEDGER + 188);
      expect(fill.percent).toEqual(12);
      expect(fill.requests).toEqual(expectedRequests);
      expectRelApproxEqual(fill.lotValue, 1116.8179, 0.005);
      expectRelApproxEqual(fill.bidValue, 1010.37453, 0.005);
    });

    it('calcs fill for liquidation auction delays fill block if filler not healthy', async () => {
      let user = Keypair.random().publicKey();
      let nextLedger = MOCK_LEDGER + 123;
      let auction = new Auction(user, AuctionType.Liquidation, {
        lot: new Map<string, bigint>([[XLM, FixedMath.toFixed(100000)]]),
        bid: new Map<string, bigint>([[XLM, FixedMath.toFixed(85000)]]),
        block: MOCK_LEDGER,
      });
      positionEstimate.totalEffectiveLiabilities = 750;
      positionEstimate.totalEffectiveCollateral = 1000;

      mockedSorobanHelper.loadUserPositionEstimate.mockResolvedValue({
        user: {} as PoolUser,
        estimate: positionEstimate,
      });
      mockedGetFillerProfitPct.mockReturnValue(0.1);
      mockedGetFilledAvailableBalances.mockResolvedValue(new Map<string, bigint>([]));

      filler.primaryAsset = USDC;
      let fill = await calculateAuctionFill(filler, auction, nextLedger, mockedSorobanHelper, db);

      let expectedRequests: Request[] = [
        {
          request_type: 6,
          address: user,
          amount: 100n,
        },
      ];
      expect(fill.block).toEqual(MOCK_LEDGER + 300);
      expect(fill.percent).toEqual(100);
      expect(fill.requests).toEqual(expectedRequests);
      expectRelApproxEqual(fill.lotValue, 9900.8679, 0.005);
      expectRelApproxEqual(fill.bidValue, 4209.893874, 0.005);
    });

    it('calcs fill for liquidation auction with repayment, additional collateral, and scaling minor', async () => {
      let user = Keypair.random().publicKey();
      let nextLedger = MOCK_LEDGER + 123;
      let auction = new Auction(user, AuctionType.Liquidation, {
        lot: new Map<string, bigint>([[XLM, FixedMath.toFixed(100000)]]),
        bid: new Map<string, bigint>([[XLM, FixedMath.toFixed(85000)]]),
        block: MOCK_LEDGER,
      });
      positionEstimate.totalEffectiveLiabilities = 0;
      positionEstimate.totalEffectiveCollateral = 1000;

      mockedSorobanHelper.loadUserPositionEstimate.mockResolvedValue({
        user: {} as PoolUser,
        estimate: positionEstimate,
      });
      mockedGetFillerProfitPct.mockReturnValue(0.1);
      mockedGetFilledAvailableBalances.mockResolvedValue(
        new Map<string, bigint>([
          [XLM, FixedMath.toFixed(15000)],
          [USDC, FixedMath.toFixed(4000)],
        ])
      );

      filler.primaryAsset = USDC;
      let fill = await calculateAuctionFill(filler, auction, nextLedger, mockedSorobanHelper, db);

      let expectedRequests: Request[] = [
        {
          request_type: 6,
          address: user,
          amount: 94n,
        },
        {
          request_type: 5,
          address: XLM,
          amount: FixedMath.toFixed(15000),
        },
        {
          request_type: 2,
          address: USDC,
          amount: FixedMath.toFixed(3954),
        },
      ];
      expect(fill.block).toEqual(MOCK_LEDGER + 188);
      expect(fill.percent).toEqual(94);
      expect(fill.requests).toEqual(expectedRequests);
      expectRelApproxEqual(fill.lotValue, 8748.4069, 0.005);
      expectRelApproxEqual(fill.bidValue, 7914.600483, 0.005);
    });

    it('calcs fill for liquidation auction with repayment, additional collateral, and scaling large', async () => {
      let user = Keypair.random().publicKey();
      let nextLedger = MOCK_LEDGER + 1;
      let auction = new Auction(user, AuctionType.Liquidation, {
        lot: new Map<string, bigint>([[EURC, FixedMath.toFixed(9100)]]),
        bid: new Map<string, bigint>([
          [USDC, FixedMath.toFixed(500)],
          [XLM, FixedMath.toFixed(85000)],
        ]),
        block: MOCK_LEDGER,
      });
      positionEstimate.totalEffectiveLiabilities = 700;
      positionEstimate.totalEffectiveCollateral = 1000;

      mockedSorobanHelper.loadUserPositionEstimate.mockResolvedValue({
        user: {} as PoolUser,
        estimate: positionEstimate,
      });
      mockedGetFillerProfitPct.mockReturnValue(0.1);
      mockedGetFilledAvailableBalances.mockResolvedValue(
        new Map<string, bigint>([
          [XLM, FixedMath.toFixed(2000)],
          [USDC, FixedMath.toFixed(600)],
        ])
      );

      filler.primaryAsset = USDC;
      let fill = await calculateAuctionFill(filler, auction, nextLedger, mockedSorobanHelper, db);

      let expectedRequests: Request[] = [
        {
          request_type: 6,
          address: user,
          amount: 15n,
        },
        {
          request_type: 5,
          address: USDC,
          amount: 757637015n,
        },
        {
          request_type: 5,
          address: XLM,
          amount: FixedMath.toFixed(2000),
        },
        {
          request_type: 2,
          address: USDC,
          amount: FixedMath.toFixed(495),
        },
      ];
      expect(fill.block).toEqual(MOCK_LEDGER + 197);
      expect(fill.percent).toEqual(15);
      expect(fill.requests).toEqual(expectedRequests);
      expectRelApproxEqual(fill.lotValue, 1476.3058, 0.005);
      expectRelApproxEqual(fill.bidValue, 1338.709125, 0.005);
    });

    // *** Bad Debt Auctions ***

    it('calcs fill for bad debt auction', async () => {
      let user = Keypair.random().publicKey();
      let nextLedger = MOCK_LEDGER + 1;
      let auction = new Auction(user, AuctionType.BadDebt, {
        lot: new Map<string, bigint>([[BACKSTOP_TOKEN, FixedMath.toFixed(4200)]]),
        bid: new Map<string, bigint>([
          [XLM, FixedMath.toFixed(10000)],
          [USDC, FixedMath.toFixed(500)],
        ]),
        block: MOCK_LEDGER,
      });
      positionEstimate.totalEffectiveLiabilities = 0;
      positionEstimate.totalEffectiveCollateral = 1000;

      mockedSorobanHelper.loadUserPositionEstimate.mockResolvedValue({
        user: {} as PoolUser,
        estimate: positionEstimate,
      });
      mockedGetFillerProfitPct.mockReturnValue(0.1);
      mockedGetFilledAvailableBalances.mockResolvedValue(
        new Map<string, bigint>([
          [USDC, FixedMath.toFixed(4200)],
          [XLM, FixedMath.toFixed(5000)],
        ])
      );

      let fill = await calculateAuctionFill(filler, auction, nextLedger, mockedSorobanHelper, db);

      let expectedRequests: Request[] = [
        {
          request_type: 7,
          address: user,
          amount: 100n,
        },
        {
          request_type: 5,
          address: XLM,
          amount: FixedMath.toFixed(5000),
        },
        {
          request_type: 5,
          address: USDC,
          amount: 5050912865n,
        },
      ];
      expect(fill.block).toEqual(MOCK_LEDGER + 157);
      expect(fill.percent).toEqual(100);
      expect(fill.requests).toEqual(expectedRequests);
      expectRelApproxEqual(fill.lotValue, 1648.5, 0.005);
      expectRelApproxEqual(fill.bidValue, 1495.503014, 0.005);

      expect(mockedGetFilledAvailableBalances).toHaveBeenCalledWith(
        filler,
        [XLM, USDC],
        mockedSorobanHelper
      );
    });
  });

  describe('valueBackstopTokenInUSDC', () => {
    it('values from sim', async () => {
      let lpTokenToUSDC = 0.5;
      mockedSorobanHelper.simLPTokenToUSDC.mockResolvedValue(FixedMath.toFixed(lpTokenToUSDC));
      mockedSorobanHelper.loadBackstopToken.mockResolvedValue({
        lpTokenPrice: 1.25,
      } as BackstopToken);

      let value = await valueBackstopTokenInUSDC(mockedSorobanHelper, FixedMath.toFixed(2));

      expect(value).toEqual(lpTokenToUSDC);
      expect(mockedSorobanHelper.loadBackstopToken).toHaveBeenCalledTimes(0);
    });

    it('values from spot price if sim fails', async () => {
      mockedSorobanHelper.simLPTokenToUSDC.mockResolvedValue(undefined);
      mockedSorobanHelper.loadBackstopToken.mockResolvedValue({
        lpTokenPrice: 1.25,
      } as BackstopToken);

      let value = await valueBackstopTokenInUSDC(mockedSorobanHelper, FixedMath.toFixed(2));

      expect(value).toEqual(1.25 * 2);
      expect(mockedSorobanHelper.loadBackstopToken).toHaveBeenCalledTimes(1);
    });
  });
});

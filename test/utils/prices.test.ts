import { DexPriceSource } from '../../src/utils/config.js';
import { AuctioneerDatabase } from '../../src/utils/db.js';
import { HorizonHelper } from '../../src/utils/horizon_helper.js';
import { logger } from '../../src/utils/logger.js';
import { binancePrices, coinbasePrices, getDexPrices, setPrices } from '../../src/utils/prices.js';
import { inMemoryAuctioneerDb } from '../helpers/mocks.js';

// Mock the external modules and functions
jest.mock('../../src/utils/config.js', () => ({
  APP_CONFIG: {
    priceSources: [
      { type: 'coinbase', symbol: 'BTC-USD', assetId: 'bitcoin' },
      { type: 'coinbase', symbol: 'EURC-USD', assetId: 'eurc' },
      { type: 'binance', symbol: 'ETHUSDT', assetId: 'ethereum' },
      { type: 'binance', symbol: 'XLMUSDT', assetId: 'lumens' },
      {
        type: 'dex',
        sourceAsset: 'XLM:native',
        destAsset: 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
        destAmount: '1000',
        assetId: 'dex-lumens',
      },
      {
        type: 'dex',
        sourceAsset: 'AQUA:GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA',
        destAsset: 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
        destAmount: '1000',
        assetId: 'aqua',
      },
    ],
  },
}));

jest.mock('../../src/utils/horizon_helper.js');

jest.mock('../../src/utils/logger.js', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
  },
}));

describe('setPrices', () => {
  let db: AuctioneerDatabase;
  let mockFetch: jest.Mock;
  let test_time = Date.now();
  let test_time_epoch = Math.floor(test_time / 1000);
  let mockHorizonHelper = new HorizonHelper() as jest.Mocked<HorizonHelper>;
  let mockHorizonHelperConstructor = HorizonHelper as jest.MockedClass<typeof HorizonHelper>;

  beforeEach(() => {
    db = inMemoryAuctioneerDb();
    jest.useFakeTimers().setSystemTime(new Date(test_time));

    mockFetch = jest.fn();
    global.fetch = mockFetch;

    mockHorizonHelperConstructor.mockImplementation(() => mockHorizonHelper);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.resetAllMocks();

    db.db.prepare('DELETE FROM prices').run();
  });

  it('fetches prices from price sources and sets them in the database', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('api.coinbase.com')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            products: [
              {
                product_id: 'BTC-USD',
                price: '59573.42',
              },
              {
                product_id: 'EURC-USD',
                price: '1.111',
              },
            ],
            num_products: 2,
          }),
        });
      } else if (url.includes('api.binance.com')) {
        return Promise.resolve({
          ok: true,
          json: async () => [
            { symbol: 'ETHUSDT', price: '2604.17000000' },
            { symbol: 'XLMUSDT', price: '0.09730000' },
          ],
        });
      } else {
        return Promise.reject(new Error('Invalid URL'));
      }
    });

    mockHorizonHelper.loadStrictReceivePrice
      .mockResolvedValueOnce(0.412341)
      .mockResolvedValueOnce(0.0011341);

    await setPrices(db);

    // Check if fetch was called with the correct URLs
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.coinbase.com/api/v3/brokerage/market/products?product_ids=BTC-USD&product_ids=EURC-USD'
    );
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.binance.com/api/v3/ticker/price?symbols=["ETHUSDT","XLMUSDT"]'
    );

    // Check if the path payment was fetched correctly
    expect(mockHorizonHelper.loadStrictReceivePrice).toHaveBeenCalledWith(
      'XLM:native',
      'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      '1000'
    );
    expect(mockHorizonHelper.loadStrictReceivePrice).toHaveBeenCalledWith(
      'AQUA:GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA',
      'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      '1000'
    );

    // Check if the prices were correctly inserted into the database
    let btcPrice = db.getPriceEntry('bitcoin');
    expect(btcPrice).toEqual({ asset_id: 'bitcoin', price: 59573.42, timestamp: test_time_epoch });
    let eurcPrice = db.getPriceEntry('eurc');
    expect(eurcPrice).toEqual({ asset_id: 'eurc', price: 1.111, timestamp: test_time_epoch });
    let ethPrice = db.getPriceEntry('ethereum');
    expect(ethPrice).toEqual({ asset_id: 'ethereum', price: 2604.17, timestamp: test_time_epoch });
    let xlmPrice = db.getPriceEntry('lumens');
    expect(xlmPrice).toEqual({ asset_id: 'lumens', price: 0.0973, timestamp: test_time_epoch });

    let dexLumensPrice = db.getPriceEntry('dex-lumens');
    expect(dexLumensPrice).toEqual({
      asset_id: 'dex-lumens',
      price: 0.412341,
      timestamp: test_time_epoch,
    });
    let aquaPrice = db.getPriceEntry('aqua');
    expect(aquaPrice).toEqual({ asset_id: 'aqua', price: 0.0011341, timestamp: test_time_epoch });
  });
});

describe('coinbasePrices', () => {
  let mockFetch: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch = jest.fn();
    global.fetch = mockFetch;
  });

  it('should return an empty array if symbols array is empty', async () => {
    const result = await coinbasePrices([]);
    expect(result).toEqual([]);
  });

  it('should return prices for valid response from Coinbase', async () => {
    const mockResponse = {
      products: [
        { product_id: 'BTC-USD', price: '50000' },
        { product_id: 'ETH-USD', price: '4000' },
      ],
    };
    (fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await coinbasePrices(['BTC-USD', 'ETH-USD']);
    expect(result).toEqual([
      { symbol: 'BTC-USD', price: 50000 },
      { symbol: 'ETH-USD', price: 4000 },
    ]);
  });

  it('should return an empty array for invalid response from Coinbase', async () => {
    const mockResponse = { unexpected: 'data' };
    (fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await coinbasePrices(['BTC-USD']);
    expect(result).toEqual([]);
  });
  it('should return an empty array for ok equals false and log error', async () => {
    const mockResponse = { unexpected: 'data' };
    (fetch as jest.Mock).mockResolvedValue({
      ok: false,
      json: async () => mockResponse,
      status: 123,
      statusText: 'mock error',
    });

    const result = await coinbasePrices(['BTCUSDT']);
    expect(result).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith('Http error fetching Coinbase price: 123 mock error');
  });
  it('should return an empty array if fetch fails', async () => {
    (fetch as jest.Mock).mockRejectedValue(new Error('Fetch error'));

    const result = await coinbasePrices(['BTC-USD']);
    expect(result).toEqual([]);
  });
});

describe('binancePrices', () => {
  let mockFetch: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch = jest.fn();
    global.fetch = mockFetch;
  });

  it('should return an empty array if symbols array is empty', async () => {
    const result = await binancePrices([]);
    expect(result).toEqual([]);
  });

  it('should return prices for valid response from Binance', async () => {
    const mockResponse = [
      { symbol: 'BTCUSDT', price: '50000' },
      { symbol: 'ETHUSDT', price: '4000' },
    ];
    (fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await binancePrices(['BTCUSDT', 'ETHUSDT']);
    expect(result).toEqual([
      { symbol: 'BTCUSDT', price: 50000 },
      { symbol: 'ETHUSDT', price: 4000 },
    ]);
  });

  it('should return an empty array for invalid response from Binance', async () => {
    const mockResponse = { unexpected: 'data' };
    (fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await binancePrices(['BTCUSDT']);
    expect(result).toEqual([]);
  });

  it('should return an empty array for ok equals false and log error', async () => {
    const mockResponse = { unexpected: 'data' };
    (fetch as jest.Mock).mockResolvedValue({
      ok: false,
      json: async () => mockResponse,
      status: 123,
      statusText: 'mock error',
    });

    const result = await binancePrices(['BTCUSDT']);
    expect(result).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith('Http error fetching Binance price: 123 mock error');
  });

  it('should return an empty array if fetch fails', async () => {
    (fetch as jest.Mock).mockRejectedValue(new Error('Fetch error'));

    const result = await binancePrices(['BTCUSDT']);
    expect(result).toEqual([]);
  });
});

describe('dexPrices', () => {
  let mockHorizonHelper = new HorizonHelper() as jest.Mocked<HorizonHelper>;
  let mockHorizonHelperConstructor = HorizonHelper as jest.MockedClass<typeof HorizonHelper>;
  let test_time = Date.now();
  let test_time_epoch = Math.floor(test_time / 1000);

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(new Date(test_time));
    mockHorizonHelperConstructor.mockImplementation(() => mockHorizonHelper);
  });

  it('should return an empty array if sources array is empty', async () => {
    const result = await getDexPrices([]);
    expect(result).toEqual([]);
  });

  it('should return price entries only from correct price sources', async () => {
    const priceSources: DexPriceSource[] = [
      {
        //@ts-ignore
        type: 'dex',
        sourceAsset: 'XLM',
        destAsset: 'USDC',
        destAmount: '1000',
        assetId: 'lumens',
      },
      {
        //@ts-ignore
        type: 'dex',
        sourceAsset: 'WETH',
        destAsset: 'USDC',
        destAmount: '1000',
        assetId: 'wrapped-eth',
      },
      {
        //@ts-ignore
        type: 'dex',
        sourceAsset: 'EURC',
        destAsset: 'USDC',
        destAmount: '1000',
        assetId: 'eurc',
      },
    ];

    mockHorizonHelper.loadStrictReceivePrice
      .mockResolvedValueOnce(0.412341)
      .mockRejectedValueOnce(new Error('500 Internal Teapot Error'))
      .mockResolvedValueOnce(1.0400001);

    const result = await getDexPrices(priceSources);
    expect(result).toEqual([
      { asset_id: 'lumens', price: 0.412341, timestamp: test_time_epoch },
      { asset_id: 'eurc', price: 1.0400001, timestamp: test_time_epoch },
    ]);
  });
});

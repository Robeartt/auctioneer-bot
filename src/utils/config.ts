import { Keypair } from '@stellar/stellar-sdk';
import { readFileSync } from 'fs';
import { parse } from './json.js';
import { Version } from '@blend-capital/blend-sdk';

export interface Filler {
  name: string;
  keypair: Keypair;
  primaryAsset: string;
  defaultProfitPct: number;
  minHealthFactor: number;
  minPrimaryCollateral: bigint;
  forceFill: boolean;
  supportedBid: string[];
  supportedLot: string[];
}

export enum PriceSourceType {
  BINANCE = 'binance',
  COINBASE = 'coinbase',
  DEX = 'dex',
}

export interface PriceSourceBase {
  assetId: string;
  type: PriceSourceType;
}

export interface ExchangePriceSource extends PriceSourceBase {
  type: PriceSourceType.BINANCE | PriceSourceType.COINBASE;
  symbol: string;
}

export interface DexPriceSource extends PriceSourceBase {
  type: PriceSourceType.DEX;
  sourceAsset: string;
  destAsset: string;
  destAmount: string;
}

export type PriceSource = ExchangePriceSource | DexPriceSource;

export interface AuctionProfit {
  profitPct: number;
  supportedBid: string[];
  supportedLot: string[];
}

export interface AppConfig {
  name: string;
  rpcURL: string;
  networkPassphrase: string;
  poolAddress: string;
  backstopAddress: string;
  backstopTokenAddress: string;
  usdcAddress: string;
  blndAddress: string;
  keypair: Keypair;
  fillers: Filler[];
  version: Version;
  horizonURL: string | undefined;
  priceSources: PriceSource[] | undefined;
  profits: AuctionProfit[] | undefined;
  slackWebhook: string | undefined;
}

let APP_CONFIG: AppConfig;
if (process.env.NODE_ENV !== 'test') {
  APP_CONFIG = parse<AppConfig>(readFileSync('./data/config.json', 'utf-8'));
  let isValid = validateAppConfig(APP_CONFIG);
  if (!isValid) {
    throw new Error('Invalid config file');
  }
}
export { APP_CONFIG };

export function validateAppConfig(config: any): boolean {
  if (typeof config !== 'object' || config === null) {
    return false;
  }

  if (
    typeof config.name !== 'string' ||
    typeof config.rpcURL !== 'string' ||
    typeof config.networkPassphrase !== 'string' ||
    typeof config.poolAddress !== 'string' ||
    typeof config.backstopAddress !== 'string' ||
    typeof config.backstopTokenAddress !== 'string' ||
    typeof config.usdcAddress !== 'string' ||
    typeof config.blndAddress !== 'string' ||
    typeof config.keypair !== 'string' ||
    !validateVersion(config.version) ||
    !Array.isArray(config.fillers) ||
    (config.horizonURL !== undefined && typeof config.horizonURL !== 'string') ||
    (config.priceSources !== undefined && !Array.isArray(config.priceSources)) ||
    (config.profits !== undefined && !Array.isArray(config.profits)) ||
    (config.slackWebhook !== undefined && typeof config.slackWebhook !== 'string')
  ) {
    console.log('Invalid app config');
    return false;
  }

  config.keypair = Keypair.fromSecret(config.keypair);

  return (
    config.fillers.every(validateFiller) &&
    (config.priceSources === undefined || config.priceSources.every(validatePriceSource)) &&
    (config.profits === undefined || config.profits.every(validateAuctionProfit))
  );
}

export function validateFiller(filler: any): boolean {
  if (typeof filler !== 'object' || filler === null) {
    return false;
  }

  if (
    typeof filler.name === 'string' &&
    typeof filler.keypair === 'string' &&
    typeof filler.defaultProfitPct === 'number' &&
    typeof filler.minHealthFactor === 'number' &&
    typeof filler.forceFill === 'boolean' &&
    typeof filler.primaryAsset === 'string' &&
    typeof filler.minPrimaryCollateral === 'string' &&
    Array.isArray(filler.supportedBid) &&
    filler.supportedBid.every((item: any) => typeof item === 'string') &&
    Array.isArray(filler.supportedLot) &&
    filler.supportedLot.every((item: any) => typeof item === 'string')
  ) {
    filler.keypair = Keypair.fromSecret(filler.keypair);
    filler.minPrimaryCollateral = BigInt(filler.minPrimaryCollateral);
    return true;
  }
  console.log('Invalid filler', filler);
  return false;
}

export function validatePriceSource(priceSource: any): boolean {
  if (
    typeof priceSource !== 'object' ||
    priceSource === null ||
    priceSource.type === undefined ||
    typeof priceSource.assetId !== 'string'
  ) {
    return false;
  }

  switch (priceSource.type) {
    case PriceSourceType.BINANCE:
    case PriceSourceType.COINBASE:
      if (typeof priceSource.symbol === 'string') {
        return true;
      }
      break;
    case PriceSourceType.DEX:
      if (
        typeof priceSource.sourceAsset === 'string' &&
        priceSource.sourceAsset.includes(':') &&
        typeof priceSource.destAsset === 'string' &&
        priceSource.destAsset.includes(':') &&
        typeof priceSource.destAmount === 'string'
      ) {
        return true;
      }
      break;
    default:
      console.log('Invalid price source (unkown type)', priceSource);
      return false;
  }

  console.log('Invalid price source', priceSource);
  return false;
}

export function validateAuctionProfit(profits: any): boolean {
  if (typeof profits !== 'object' || profits === null) {
    return false;
  }

  if (
    typeof profits.profitPct === 'number' &&
    Array.isArray(profits.supportedBid) &&
    profits.supportedBid.every((item: any) => typeof item === 'string') &&
    Array.isArray(profits.supportedLot) &&
    profits.supportedLot.every((item: any) => typeof item === 'string')
  ) {
    return true;
  }

  console.log('Invalid profit', profits);
  return false;
}

export function validateVersion(version: any): boolean {
  if (typeof version !== 'string') {
    return false;
  }
  return version === Version.V1 || version === Version.V2;
}

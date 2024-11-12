import { Keypair } from '@stellar/stellar-sdk';
import { readFileSync } from 'fs';
import { parse } from './json.js';

export interface Filler {
  name: string;
  keypair: Keypair;
  primaryAsset: string;
  minProfitPct: number;
  minHealthFactor: number;
  minPrimaryCollateral: bigint;
  forceFill: boolean;
  supportedBid: string[];
  supportedLot: string[];
}

export interface PriceSource {
  assetId: string;
  type: 'coinbase' | 'binance';
  symbol: string;
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
  priceSources: PriceSource[];
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
    !Array.isArray(config.fillers) ||
    !Array.isArray(config.priceSources) ||
    (config.slackWebhook !== undefined && typeof config.slackWebhook !== 'string')
  ) {
    return false;
  }

  config.keypair = Keypair.fromSecret(config.keypair);

  return config.fillers.every(validateFiller) && config.priceSources.every(validatePriceSource);
}

export function validateFiller(filler: any): boolean {
  if (typeof filler !== 'object' || filler === null) {
    return false;
  }

  if (
    typeof filler.name === 'string' &&
    typeof filler.keypair === 'string' &&
    typeof filler.minProfitPct === 'number' &&
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
  return false;
}

export function validatePriceSource(priceSource: any): boolean {
  if (typeof priceSource !== 'object' || priceSource === null) {
    return false;
  }

  if (
    typeof priceSource.assetId === 'string' &&
    (priceSource.type === 'binance' || priceSource.type === 'coinbase') &&
    typeof priceSource.symbol === 'string'
  ) {
    return true;
  }

  return false;
}

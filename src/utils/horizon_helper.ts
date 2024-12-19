import { PoolUser, PositionsEstimate } from '@blend-capital/blend-sdk';
import { Asset, Horizon } from '@stellar/stellar-sdk';
import { APP_CONFIG } from './config.js';
import { logger } from './logger.js';

export interface PoolUserEst {
  estimate: PositionsEstimate;
  user: PoolUser;
}

export class HorizonHelper {
  url: string;

  constructor() {
    this.url = APP_CONFIG.horizonURL ?? '';
  }

  /**
   * Fetch a price based on a strict receive path payment
   * @param soureAsset - A stellar asset as a string
   * @param destAsset - A stellar asset as a string
   * @param destAmount - The amount of the destination asset (as a whole number, 0 decimals)
   * @returns The price of the destination asset in terms of the source asset
   * @panics If no path exists or if Horizon throws an error
   */
  async loadStrictReceivePrice(
    soureAsset: string,
    destAsset: string,
    destAmount: string
  ): Promise<number> {
    try {
      let horizon = new Horizon.Server(this.url, {
        allowHttp: true,
      });
      let result = await horizon
        .strictReceivePaths(
          [this.toAssetFromString(soureAsset)],
          this.toAssetFromString(destAsset),
          destAmount
        )
        .call();
      if (result.records.length === 0) {
        throw new Error('No paths found');
      }
      let firstRecord = result.records[0];
      return Number(firstRecord.destination_amount) / Number(firstRecord.source_amount);
    } catch (e) {
      logger.error(`Error loading latest ledger: ${e}`);
      throw e;
    }
  }

  /**
   * Construct an asset from it's string representation
   * @param asset - 'assetCode:issuer' or 'XLM:native'
   * @returns The asset object
   */
  toAssetFromString(asset: string): Asset {
    let parts = asset.split(':');
    return parts[0] === 'XLM' ? Asset.native() : new Asset(parts[0], parts[1]);
  }
}

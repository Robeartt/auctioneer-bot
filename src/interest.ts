import { SorobanHelper } from './utils/soroban_helper.js';
import { WorkSubmission, WorkSubmissionType } from './work_submitter.js';
import { logger } from './utils/logger.js';
import { FixedMath, AuctionType } from '@blend-capital/blend-sdk';
import { checkFillerSupport } from './filler.js';
import { APP_CONFIG } from './utils/config.js';

export async function checkPoolForInterestAuction(
  sorobanHelper: SorobanHelper,
  poolId: string
): Promise<WorkSubmission | undefined> {
  try {
    const pool = await sorobanHelper.loadPool(poolId);
    const poolOracle = await sorobanHelper.loadPoolOracle(poolId);

    // use the pools max auction lot size or at most 3 lot assets
    let maxLotAssets = Math.min(pool.metadata.maxPositions - 1, 3);
    let totalInterest = 0;
    let lotAssets = [];
    let backstopCredit: [string, number][] = [];
    for (const [assetId, reserve] of pool.reserves) {
      const assetPrice = poolOracle.getPrice(assetId) ?? BigInt(0);
      const priceFloat = FixedMath.toFloat(assetPrice, poolOracle.decimals);
      const creditFloat = FixedMath.toFloat(reserve.data.backstopCredit, reserve.config.decimals);
      backstopCredit.push([assetId, priceFloat * creditFloat]);
    }
    // sort by highest backstop credit first
    backstopCredit.sort((a, b) => b[1] - a[1]);
    for (let i = 0; i < backstopCredit.length; i++) {
      const [assetId, credit] = backstopCredit[i];
      if (credit < 10 || i + 1 >= maxLotAssets) {
        break;
      }
      totalInterest += credit;
      lotAssets.push(assetId);
    }
    if (totalInterest > 300) {
      const bid = [APP_CONFIG.backstopTokenAddress];
      const lot = lotAssets;

      // validate the expected filler has enough backstop tokens to fill
      for (const filler of APP_CONFIG.fillers) {
        if (checkFillerSupport(filler, poolId, bid, lot)) {
          // found a filler - ensure it has enough backstop tokens to make the auction
          const backstopToken = await sorobanHelper.loadBackstopToken();
          const backstopTokenBalance = await sorobanHelper.simBalance(
            APP_CONFIG.backstopTokenAddress,
            filler.keypair.publicKey()
          );
          const bidValue = FixedMath.toFloat(backstopTokenBalance) * backstopToken.lpTokenPrice;

          if (bidValue > totalInterest) {
            logger.info(
              `Creating backstop interest auction for pool ${poolId}, value: ${totalInterest}, lot assets: ${lotAssets}`
            );
            return {
              type: WorkSubmissionType.AuctionCreation,
              poolId,
              user: APP_CONFIG.backstopAddress,
              auctionType: AuctionType.Interest,
              auctionPercent: 100,
              bid: [APP_CONFIG.backstopTokenAddress],
              lot: lotAssets,
            };
          } else {
            const logMessage =
              `Filler ran out of have enough backstop tokens to create backstop interest auction.\n` +
              `User: ${filler.keypair.publicKey()}\n` +
              `Balance: ${FixedMath.toFloat(backstopTokenBalance)}\n` +
              `Required: ${totalInterest / backstopToken.lpTokenPrice}`;
            logger.error(logMessage);
            return undefined;
          }
        }
      }
    } else {
      logger.info(
        `No backstop interest auction needed for pool ${poolId}, value: ${totalInterest}`
      );
      return undefined;
    }
  } catch (e) {
    logger.error(`Error checking backstop interest in pool ${poolId}: ${e}`);
    return undefined;
  }
}

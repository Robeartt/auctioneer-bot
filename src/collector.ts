import { poolEventFromEventResponse } from '@blend-capital/blend-sdk';
import { rpc } from '@stellar/stellar-sdk';
import { ChildProcess } from 'child_process';
import {
  EventType,
  LedgerEvent,
  LiqScanEvent,
  OracleScanEvent,
  PoolEventEvent,
  PriceUpdateEvent,
  UserRefreshEvent,
} from './events.js';
import { PoolEventHandler } from './pool_event_handler.js';
import { AuctioneerDatabase } from './utils/db.js';
import { stringify } from './utils/json.js';
import { logger } from './utils/logger.js';
import { sendEvent } from './utils/messages.js';
import { PoolConfig } from './utils/config.js';
import { Api } from '@stellar/stellar-sdk/rpc';

let startup_ledger = 0;

export async function runCollector(
  worker: ChildProcess,
  bidder: ChildProcess,
  db: AuctioneerDatabase,
  stellarRpc: rpc.Server,
  poolConfigs: PoolConfig[],
  poolEventHandler: PoolEventHandler
) {
  const timer = Date.now();
  let statusEntry = db.getStatusEntry('collector');
  if (!statusEntry) {
    statusEntry = { name: 'collector', latest_ledger: 0 };
  }
  const latestLedger = (await stellarRpc.getLatestLedger()).sequence;
  if (latestLedger > statusEntry.latest_ledger) {
    logger.info(`Processing ledger ${latestLedger}`);

    // determine ledgers since bot was started to send long running work events
    // this staggers the events from different bots running on the same pool
    if (startup_ledger === 0) {
      startup_ledger = latestLedger;
    }
    const ledgersProcessed = latestLedger - startup_ledger;
    if (ledgersProcessed % 10 === 0) {
      // approx every minute
      const event: PriceUpdateEvent = {
        type: EventType.PRICE_UPDATE,
        timestamp: Date.now(),
      };
      sendEvent(worker, event);
    }

    for (const poolConfig of poolConfigs) {
      // new ledger detected
      const ledger_event: LedgerEvent = {
        type: EventType.LEDGER,
        timestamp: Date.now(),
        ledger: latestLedger,
        poolConfig,
      };
      sendEvent(bidder, ledger_event);
      // send long running work events to worker
      if (ledgersProcessed % 60 === 0) {
        // approx every 5m
        // send an oracle scan event
        const event: OracleScanEvent = {
          type: EventType.ORACLE_SCAN,
          timestamp: Date.now(),
          poolConfig,
        };
        sendEvent(worker, event);
      }
      if (ledgersProcessed % 1203 === 0) {
        // approx every 2hr
        // send a user update event to update any users that have not been updated in ~2 weeks
        const event: UserRefreshEvent = {
          type: EventType.USER_REFRESH,
          timestamp: Date.now(),
          cutoff: Math.max(latestLedger - 14 * 17280, 0),
          poolConfig,
        };
        sendEvent(worker, event);
      }
      if (ledgersProcessed % 1207 === 0) {
        // approx every 2hr
        // send a liq scan event
        const event: LiqScanEvent = {
          type: EventType.LIQ_SCAN,
          timestamp: Date.now(),
          poolConfig,
        };
        sendEvent(worker, event);
      }
    }
    // fetch events from last ledger and paging token
    // start from the ledger after the last one we processed
    let start_ledger =
      statusEntry.latest_ledger === 0 ? latestLedger : statusEntry.latest_ledger + 1;
    // if we are too far behind, start from 17270 ledgers ago (default max ledger history is 17280)
    start_ledger = Math.max(start_ledger, latestLedger - 17270);
    let events: rpc.Api.RawGetEventsResponse;
    const filters = createFilter(poolConfigs);
    try {
      events = await stellarRpc._getEvents({
        startLedger: start_ledger,
        filters: filters,
        limit: 100,
      });
    } catch (e: any) {
      // Handles the case where the rpc server is restarted and no longer has events from the start ledger we requested
      if (e.code === -32600) {
        logger.error(
          `Error fetching events at start ledger: ${start_ledger}, retrying with latest ledger ${latestLedger}`,
          e
        );
        events = await stellarRpc._getEvents({
          startLedger: latestLedger,
          filters: filters,
          limit: 100,
        });
      } else {
        throw e;
      }
    }
    let cursor = '';
    while (events.events.length > 0) {
      for (const raw_event of events.events) {
        let blendPoolEvent = poolEventFromEventResponse(raw_event);
        if (blendPoolEvent) {
          // handle pool events immediately
          let poolConfig = poolConfigs.find(
            (config) => config.poolAddress === blendPoolEvent.contractId
          );
          if (!poolConfig) {
            logger.error(`Pool config not found for event: ${stringify(blendPoolEvent)}`);
            continue;
          }
          let poolEvent: PoolEventEvent = {
            type: EventType.POOL_EVENT,
            timestamp: Date.now(),
            event: blendPoolEvent,
            poolConfig,
          };
          logger.info(`Processing pool event: ${stringify(poolEvent)}`);
          await poolEventHandler.processEventWithRetryAndDeadLetter(poolEvent);
        }
      }
      cursor = events.events[events.events.length - 1].pagingToken;
      events = await stellarRpc._getEvents({
        cursor: cursor,
        filters: filters,
        limit: 100,
      });
    }
    statusEntry.latest_ledger = latestLedger;

    // update status entry with processed ledger
    db.setStatusEntry(statusEntry);
    logger.info(`Processed ledger ${latestLedger} in ${Date.now() - timer}ms`);
  }
}

function createFilter(poolConfigs: PoolConfig[]) {
  let pools = poolConfigs.map((poolConfig) => poolConfig.poolAddress);
  let filter: Api.EventFilter[] = [];
  for (let i = 0; i < pools.length; i += 5) {
    filter.push({
      type: 'contract',
      contractIds: pools.slice(i, i + 5),
    });
  }
  return filter;
}

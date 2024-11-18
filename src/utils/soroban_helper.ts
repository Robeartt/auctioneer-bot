import {
  Auction,
  AuctionData,
  BackstopToken,
  ContractErrorType,
  Network,
  parseError,
  Pool,
  PoolContract,
  PoolOracle,
  PoolUser,
  PositionsEstimate,
} from '@blend-capital/blend-sdk';
import {
  Account,
  BASE_FEE,
  Contract,
  Keypair,
  nativeToScVal,
  scValToNative,
  SorobanRpc,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import { APP_CONFIG } from './config.js';
import { logger } from './logger.js';

export interface PoolUserEst {
  estimate: PositionsEstimate;
  user: PoolUser;
}

export class SorobanHelper {
  network: Network;
  private pool_cache: Pool | undefined;
  private user_cache: Map<string, PoolUser> = new Map();
  private oracle_cache: PoolOracle | undefined;

  constructor() {
    this.network = {
      rpc: APP_CONFIG.rpcURL,
      passphrase: APP_CONFIG.networkPassphrase,
      opts: {
        allowHttp: true,
      },
    };
    this.pool_cache = undefined;
  }

  async loadLatestLedger(): Promise<number> {
    try {
      let rpc = new SorobanRpc.Server(this.network.rpc, this.network.opts);
      let ledger = await rpc.getLatestLedger();
      return ledger.sequence;
    } catch (e) {
      logger.error(`Error loading latest ledger: ${e}`);
      throw e;
    }
  }

  async loadPool(): Promise<Pool> {
    if (this.pool_cache) {
      return this.pool_cache;
    } else {
      this.pool_cache = await Pool.load(this.network, APP_CONFIG.poolAddress);
      return this.pool_cache;
    }
  }

  async loadUser(address: string): Promise<PoolUser> {
    if (this.user_cache.has(address)) {
      return this.user_cache.get(address) as PoolUser;
    } else {
      const pool = await this.loadPool();
      const user = await pool.loadUser(address);
      this.user_cache.set(address, user);
      return user;
    }
  }

  async loadPoolOracle(): Promise<PoolOracle> {
    try {
      if (this.oracle_cache) {
        return this.oracle_cache;
      }
      const pool = await this.loadPool();
      const oracle = await pool.loadOracle();
      this.oracle_cache = oracle;
      return oracle;
    } catch (e) {
      logger.error(`Error loading pool oracle: ${e}`);
      throw e;
    }
  }

  async loadUserPositionEstimate(address: string): Promise<PoolUserEst> {
    try {
      const pool = await this.loadPool();
      const user = await pool.loadUser(address);
      const poolOracle = await pool.loadOracle();
      return { estimate: PositionsEstimate.build(pool, poolOracle, user.positions), user };
    } catch (e) {
      logger.error(`Error loading user position estimate: ${e}`);
      throw e;
    }
  }

  async loadAuction(userId: string, auctionType: number): Promise<Auction | undefined> {
    try {
      let rpc = new SorobanRpc.Server(this.network.rpc, this.network.opts);
      const ledgerKey = AuctionData.ledgerKey(APP_CONFIG.poolAddress, {
        auct_type: auctionType,
        user: userId,
      });
      let ledgerData = await rpc.getLedgerEntries(ledgerKey);
      if (ledgerData.entries.length === 0) {
        return undefined;
      }
      let auctionData = PoolContract.parsers.getAuction(
        ledgerData.entries[0].val.contractData().val().toXDR('base64')
      );
      return new Auction(userId, auctionType, auctionData);
    } catch (e) {
      logger.error(`Error loading auction: ${e}`);
      throw e;
    }
  }

  async loadBackstopToken(): Promise<BackstopToken> {
    return await BackstopToken.load(
      this.network,
      APP_CONFIG.backstopTokenAddress,
      APP_CONFIG.blndAddress,
      APP_CONFIG.usdcAddress
    );
  }

  /**
   * @dev WARNING: If loading balances for the filler, use `getFillerAvailableBalances` instead.
   */
  async loadBalances(userId: string, tokens: string[]): Promise<Map<string, bigint>> {
    try {
      let balances = new Map<string, bigint>();

      // break tokens array into chunks of at most 5 tokens
      let concurrency_limit = 5;
      let promise_chunks: string[][] = [];
      for (let i = 0; i < tokens.length; i += concurrency_limit) {
        promise_chunks.push(tokens.slice(i, i + concurrency_limit));
      }

      // fetch each chunk of token balances concurrently
      for (const chunk of promise_chunks) {
        const chunkResults = await Promise.all(
          chunk.map((token) => this.simBalance(token, userId))
        );
        chunk.forEach((token, index) => {
          balances.set(token, chunkResults[index]);
        });
      }
      return balances;
    } catch (e) {
      logger.error(`Error loading balances: ${e}`);
      throw e;
    }
  }

  async simLPTokenToUSDC(amount: bigint): Promise<bigint | undefined> {
    try {
      let comet = new Contract(APP_CONFIG.backstopTokenAddress);
      let op = comet.call(
        'wdr_tokn_amt_in_get_lp_tokns_out',
        ...[
          nativeToScVal(APP_CONFIG.usdcAddress, { type: 'address' }),
          nativeToScVal(amount, { type: 'i128' }),
          nativeToScVal(0, { type: 'i128' }),
          nativeToScVal(APP_CONFIG.backstopAddress, { type: 'address' }),
        ]
      );
      let account = new Account(Keypair.random().publicKey(), '123');
      let tx = new TransactionBuilder(account, {
        networkPassphrase: this.network.passphrase,
        fee: BASE_FEE,
        timebounds: { minTime: 0, maxTime: Math.floor(Date.now() / 1000) + 5 * 60 * 1000 },
      })
        .addOperation(op)
        .build();
      let rpc = new SorobanRpc.Server(this.network.rpc, this.network.opts);

      let result = await rpc.simulateTransaction(tx);
      if (SorobanRpc.Api.isSimulationSuccess(result) && result.result?.retval) {
        return scValToNative(result.result.retval);
      }
      return undefined;
    } catch (e) {
      logger.error(`Error calculating comet token value: ${e}`);
      return undefined;
    }
  }

  async simBalance(tokenId: string, userId: string): Promise<bigint> {
    try {
      let contract = new Contract(tokenId);
      let op = contract.call('balance', ...[nativeToScVal(userId, { type: 'address' })]);
      let account = new Account(Keypair.random().publicKey(), '123');
      let tx = new TransactionBuilder(account, {
        networkPassphrase: this.network.passphrase,
        fee: BASE_FEE,
        timebounds: { minTime: 0, maxTime: Math.floor(Date.now() / 1000) + 5 * 60 * 1000 },
      })
        .addOperation(op)
        .build();
      let rpc = new SorobanRpc.Server(this.network.rpc, this.network.opts);

      let result = await rpc.simulateTransaction(tx);
      if (SorobanRpc.Api.isSimulationSuccess(result) && result.result?.retval) {
        return scValToNative(result.result.retval);
      } else {
        return 0n;
      }
    } catch (e) {
      logger.error(`Error fetching balance: ${e}`);
      return 0n;
    }
  }

  async submitTransaction<T>(
    operation: string,
    keypair: Keypair
  ): Promise<SorobanRpc.Api.GetSuccessfulTransactionResponse & { txHash: string }> {
    const rpc = new SorobanRpc.Server(this.network.rpc, this.network.opts);
    const curr_time = Date.now();
    const account = await rpc.getAccount(keypair.publicKey());
    const tx = new TransactionBuilder(account, {
      networkPassphrase: this.network.passphrase,
      fee: BASE_FEE,
      timebounds: { minTime: 0, maxTime: Math.floor(Date.now() / 1000) + 5 * 60 * 1000 },
    })
      .addOperation(xdr.Operation.fromXDR(operation, 'base64'))
      .build();

    logger.info(`Attempting to simulate and submit transaction: ${tx.toXDR()}`);
    const simResult = await rpc.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationSuccess(simResult)) {
      let assembledTx = SorobanRpc.assembleTransaction(tx, simResult).build();
      assembledTx.sign(keypair);
      let txResponse = await rpc.sendTransaction(assembledTx);
      while (txResponse.status === 'TRY_AGAIN_LATER' && Date.now() - curr_time < 20000) {
        await new Promise((resolve) => setTimeout(resolve, 4000));
        txResponse = await rpc.sendTransaction(assembledTx);
      }
      if (txResponse.status !== 'PENDING') {
        const error = parseError(txResponse);
        logger.error(
          `Transaction failed to send: Tx Hash: ${txResponse.hash} Error Result XDR: ${txResponse.errorResult?.toXDR('base64')} Parsed Error: ${ContractErrorType[error.type]}`
        );
        throw error;
      }

      let get_tx_response = await rpc.getTransaction(txResponse.hash);
      while (get_tx_response.status === 'NOT_FOUND') {
        await new Promise((resolve) => setTimeout(resolve, 250));
        get_tx_response = await rpc.getTransaction(txResponse.hash);
      }

      if (get_tx_response.status !== 'SUCCESS') {
        const error = parseError(get_tx_response);
        logger.error(
          `Tx Failed: ${ContractErrorType[error.type]}, Error Result XDR: ${get_tx_response.resultXdr.toXDR('base64')}`
        );

        throw error;
      }
      logger.info(
        'Transaction successfully submitted: ' +
          `Ledger: ${get_tx_response.ledger} ` +
          `Latest Ledger Close Time: ${get_tx_response.latestLedgerCloseTime} ` +
          `Transaction Result XDR: ${get_tx_response.resultXdr.toXDR('base64')} ` +
          `Tx Envelope XDR: ${get_tx_response.envelopeXdr.toXDR('base64')}` +
          `Tx Hash:
          ${txResponse.hash}`
      );
      return { ...get_tx_response, txHash: txResponse.hash };
    }
    const error = parseError(simResult);
    logger.error(`Tx failed to simlate: ${ContractErrorType[error.type]}`);
    throw error;
  }
}

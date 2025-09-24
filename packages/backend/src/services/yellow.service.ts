import { ethers } from 'ethers';
import { env } from '../config/environment';
import { logger } from '../utils/logger';
// Import extensionless so runtime resolves dist/services/abi/Nitrolite.js
import VaultABI from './abi/Nitrolite';
import ChannelManagerABI from './abi/ChannelManager.json';
import TokenABI from './abi/NitroliteToken.json';
import AdjudicatorABI from './abi/Adjudicator.json';

class YellowService {
  private provider: ethers.JsonRpcProvider;
  private signer: ethers.Signer;
  private channelManager: ethers.Contract;
  private vault: ethers.Contract;
  private token: ethers.Contract;
  private adjudicator: ethers.Contract;
  private ready = false;
  private initPromise: Promise<void> | null = null;
  private initAttempts = 0;
  private lastInitError: string | null = null;
  private lastInitAt: number | null = null;
  private lastReadyAt: number | null = null;

  constructor() {
    // In tests, avoid network calls and event loop handles
    if (process.env.NODE_ENV === 'test') {
      // Minimal no-op initialization
      // Use dummy provider/signer to satisfy types, but do not call RPC
      // Note: we intentionally don't construct contracts or run init()
      this.provider = new ethers.JsonRpcProvider('http://localhost:0');
      // Generate a throwaway wallet not connected to provider
  this.signer = new ethers.Wallet(ethers.hexlify(ethers.randomBytes(32)));
  this.channelManager = {} as unknown as ethers.Contract;
  this.vault = {} as unknown as ethers.Contract;
  this.token = {} as unknown as ethers.Contract;
  this.adjudicator = {} as unknown as ethers.Contract;
      this.ready = true;
      logger.info('Sepolia channel service initialized (test mode)');
      return;
    }
    // Validate required Sepolia envs
    if (!env.blockchain.rpcProvider) throw new Error('JSON_RPC_PROVIDER is required');
    if (!env.blockchain.adminPrivateKey) throw new Error('ADMIN_PRIVATE_KEY is required');
    if (!env.blockchain.creatorVaultAddress) throw new Error('CREATOR_VAULT_ADDRESS is required');
  if (!env.nitrolite?.custody) throw new Error('NITROLITE_CUSTODY_ADDRESS is required');
  if (!env.nitrolite?.token) throw new Error('NITROLITE_TOKEN_ADDRESS is required');
  if (!env.nitrolite?.adjudicator) throw new Error('NITROLITE_ADJUDICATOR_ADDRESS is required');
    if (env.yellow.chainId !== 11155111) throw new Error('CHANNEL_CHAIN_ID must be 11155111 (Sepolia)');

    this.provider = new ethers.JsonRpcProvider(env.blockchain.rpcProvider);
    this.signer = new ethers.Wallet(env.blockchain.adminPrivateKey, this.provider);
    // Initialize contracts & validate bytecode exists (lazy, non-fatal at startup)
  this.channelManager = new ethers.Contract(env.nitrolite.custody, (ChannelManagerABI as any).abi, this.signer);
  this.vault = new ethers.Contract(env.blockchain.creatorVaultAddress, (VaultABI as any).abi, this.signer);
  this.token = new ethers.Contract(env.nitrolite.token, (TokenABI as any).abi, this.signer);
  this.adjudicator = new ethers.Contract(env.nitrolite.adjudicator, (AdjudicatorABI as any).abi, this.signer);
    this.init();
    logger.info('Sepolia channel service initialized (ethers.js)');
  }

  private init() {
    if (this.initPromise) return this.initPromise;
  this.initAttempts += 1;
  this.lastInitAt = Date.now();
    const fetchCodes = async () => {
      const attempt = async (fn: () => Promise<any>, label: string, tries = 3): Promise<string> => {
        let lastErr: any;
        for (let i=0;i<tries;i++) {
          try { return await fn(); } catch (e:any) {
            lastErr = e;
            const transient = /ECONNRESET|socket hang up|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH/i.test(e?.message||'');
            if (!transient) break;
            const delay = 400 * (i+1);
            logger.warn({ err: e?.message, attempt: i+1, delay, label }, 'Transient RPC error; retrying');
            await new Promise(r => setTimeout(r, delay));
          }
        }
        throw lastErr;
      };
      return Promise.all([
        attempt(() => this.provider.getCode(env.nitrolite.custody), 'custody'),
        attempt(() => this.provider.getCode(env.blockchain.creatorVaultAddress), 'vault'),
        attempt(() => this.provider.getCode(env.nitrolite.token), 'token'),
        attempt(() => this.provider.getCode(env.nitrolite.adjudicator), 'adjudicator'),
      ]);
    };
    this.initPromise = fetchCodes()
      .then(([chanCode, vaultCode, tokenCode, adjCode]) => {
        if (chanCode === '0x') {
          logger.error('No code at NITROLITE_CUSTODY_ADDRESS – deploy ChannelManager and update env');
          this.ready = false;
          this.lastInitError = 'missing_channel_manager_code';
          return;
        }
        if (vaultCode === '0x') {
          logger.error('No code at CREATOR_VAULT_ADDRESS – deploy Nitrolite and update env');
          this.ready = false;
          this.lastInitError = 'missing_vault_code';
          return;
        }
        if (tokenCode === '0x') {
          logger.error('No code at NITROLITE_TOKEN_ADDRESS – deploy token and update env');
          this.ready = false; this.lastInitError = 'missing_token_code'; return;
        }
        if (adjCode === '0x') {
          logger.error('No code at NITROLITE_ADJUDICATOR_ADDRESS – deploy adjudicator and update env');
          this.ready = false; this.lastInitError = 'missing_adjudicator_code'; return;
        }
        this.ready = true;
        this.lastReadyAt = Date.now();
        this.lastInitError = null;
        logger.info('Sepolia contracts found, nitrolite service ready');
        // Fetch admin signer balance for diagnostics
    this.signer.getAddress().then(addr => this.provider.getBalance(addr).then(bal => {
          const eth = Number(ethers.formatEther(bal));
          if (eth < 0.001) {
      logger.warn({ address: addr, balanceEth: eth }, 'Admin signer low balance; on-chain channel open may fail');
          } else {
      logger.info({ address: addr, balanceEth: eth }, 'Admin signer funded');
          }
    })).catch(err => logger.warn({ err: err?.message }, 'Failed to fetch admin signer balance'));
      })
      .catch((e) => {
        this.ready = false;
  this.lastInitError = (e as any)?.message || 'init_failed';
  logger.error({ err: this.lastInitError, attempts: this.initAttempts }, 'Contract code validation failed (will retry on next demand)');
  // Critical: allow subsequent calls to init() to retry by clearing cached promise
  this.initPromise = null;
      });
    return this.initPromise;
  }

  public isReady() { return this.ready; }

  private async ensureReady() {
    if (this.ready) return true;
    await this.init();
    return this.ready;
  }

  // Validate a viewer-submitted openChannel transaction and ensure it matches expected args/value
  async validateOpenTx(txHash: string, viewer: string, streamIdOrSalted: string, vaultId: bigint, depositWei: bigint): Promise<{ ok: true }>{
  if (!await this.ensureReady()) throw new Error('ChannelManager not ready. Deploy contracts and set env.');
    const tx = await this.provider.getTransaction(txHash);
    if (!tx) throw new Error('open tx not found');
    if ((tx.to || '').toLowerCase() !== String(this.channelManager.target).toLowerCase()) throw new Error('tx to wrong contract');
    if (tx.value !== depositWei) throw new Error('tx value mismatch');
    // Decode call data
    const parsed = (this.channelManager.interface as any).parseTransaction({ data: tx.data, value: tx.value });
    if (!parsed || parsed.name !== 'openChannel') throw new Error('not an openChannel call');
    const [argViewer, argStreamIdHash, argVaultId] = parsed.args as any[];
  // streamIdOrSalted may include ":salt" suffix for forced-new channels
  const expectedHash = ethers.id(streamIdOrSalted);
    if (String(argViewer).toLowerCase() !== viewer.toLowerCase()) throw new Error('viewer mismatch');
    if (String(argStreamIdHash).toLowerCase() !== expectedHash.toLowerCase()) throw new Error('streamId hash mismatch');
    if (BigInt(argVaultId) !== BigInt(vaultId)) throw new Error('vaultId mismatch');
    // Ensure it’s mined and successful
  const rc = await this.provider.waitForTransaction(txHash, 1, 60_000);
  if (!rc || Number(rc.status ?? 0) !== 1) throw new Error('open tx failed');
    return { ok: true };
  }

  // On-chain open channel tx
  async openChannel(viewer: string, streamIdOrSalted: string, vaultId: bigint, depositWei: bigint): Promise<{ txHash: string }>{
  if (!await this.ensureReady()) throw new Error('ChannelManager not ready. Deploy contracts and set env.');
  const streamIdHash = ethers.id(streamIdOrSalted);
  const tx = await this.channelManager.openChannel(viewer, streamIdHash, vaultId, { value: depositWei });
    const rcpt = await tx.wait(1);
    return { txHash: rcpt.hash || tx.hash };
  }

  // On-chain close channel settlement
  async closeChannel(channelId: string, spentWei: bigint): Promise<{ txHash: string }>{
  if (!await this.ensureReady()) throw new Error('ChannelManager not ready. Deploy contracts and set env.');
  const tx = await this.channelManager.closeChannel(channelId, spentWei);
  const rcpt = await tx.wait(1);
  return { txHash: rcpt.hash || tx.hash };
  }

  async depositToVault(vaultId: bigint, amount: bigint): Promise<string> {
    const tx = await (this.vault as any).deposit(vaultId, { value: amount });
  const rc = await tx.wait(1);
  return rc.hash || tx.hash;
  }

  async adjudicate(state: { channelId: string; vaultId: bigint|string; viewer: string; deposit: bigint|string; spent: bigint|string; nonce: bigint|string }, signature: string): Promise<string> {
    // Dev fallback when contracts aren’t ready or RPC not available
    if (!this.ready && process.env.NODE_ENV !== 'production') {
      const mock = ethers.keccak256(ethers.toUtf8Bytes(`mock-adjudicate:${JSON.stringify(state)}:${signature}:${Date.now()}`));
      logger.warn({ tx: mock }, 'Dev mode: adjudicate fallback (contracts not ready)');
      return mock;
    }
    try {
  if (!await this.ensureReady()) throw new Error('Adjudicator not ready');
      // Coerce potential string inputs to bigint for contract call
      const normalized = {
        channelId: state.channelId,
        vaultId: BigInt(state.vaultId as any),
        viewer: state.viewer,
        deposit: BigInt(state.deposit as any),
        spent: BigInt(state.spent as any),
        nonce: BigInt(state.nonce as any),
      } as any;
  const tx = await (this.adjudicator as any).adjudicate(normalized, signature, state.viewer);
  const rc = await tx.wait(1);
  return rc.hash || tx.hash;
    } catch (e) {
      if (process.env.NODE_ENV !== 'production') {
        const mock = ethers.keccak256(ethers.toUtf8Bytes(`mock-adjudicate-error:${JSON.stringify(state)}:${signature}:${Date.now()}`));
        logger.warn({ err: (e as any)?.message, tx: mock }, 'Dev mode: adjudicate failed; returning mock tx');
        return mock;
      }
      throw e;
    }
  }

  // Read on-chain channel mapping for diagnostics
  async getOnchainChannel(channelId: string): Promise<{
    viewer: string;
    vaultId: string;
    deposit: string;
    spent: string;
    closed: boolean;
  } | null> {
    if (!this.ready) { await this.init(); }
    if (!this.ready) return null;
    try {
      const ch: any = await (this.channelManager as any).channels(channelId);
      if (!ch) return null;
      return {
        viewer: String(ch.viewer),
        vaultId: String(ch.vaultId?.toString?.() ?? ch.vaultId),
        deposit: String(ch.deposit?.toString?.() ?? ch.deposit),
        spent: String(ch.spent?.toString?.() ?? ch.spent),
        closed: Boolean(ch.closed),
      };
    } catch (e) {
      logger.warn({ err: (e as any)?.message }, 'getOnchainChannel failed');
      return null;
    }
  }

  public async getAdminStatus() {
    try {
  const addr = await this.signer.getAddress();
  let balStr: string | null = null;
  let balEth: string | null = null;
  try {
    const bal = await this.provider.getBalance(addr);
    balStr = bal.toString();
    balEth = ethers.formatEther(bal);
  } catch (balanceErr:any) {
    logger.warn({ err: balanceErr?.message }, 'Failed to fetch admin balance');
  }
  return { address: addr, balanceWei: balStr, balanceEth: balEth, ready: this.ready };
    } catch (e:any) {
  return { address: null, error: e.message, ready: this.ready };
    }
  }

  public getStatus() {
    return {
      ready: this.ready,
      attempts: this.initAttempts,
      lastInitAt: this.lastInitAt,
      lastReadyAt: this.lastReadyAt,
      lastInitError: this.lastInitError,
    };
  }
}

export const yellowService = new YellowService();

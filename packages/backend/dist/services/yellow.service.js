"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.yellowService = void 0;
const ethers_1 = require("ethers");
const environment_1 = require("../config/environment");
const logger_1 = require("../utils/logger");
// Import extensionless so runtime resolves dist/services/abi/Nitrolite.js
const Nitrolite_1 = __importDefault(require("./abi/Nitrolite"));
const ChannelManager_json_1 = __importDefault(require("./abi/ChannelManager.json"));
const NitroliteToken_json_1 = __importDefault(require("./abi/NitroliteToken.json"));
const Adjudicator_json_1 = __importDefault(require("./abi/Adjudicator.json"));
class YellowService {
    provider;
    signer;
    channelManager;
    vault;
    token;
    adjudicator;
    ready = false;
    initPromise = null;
    initAttempts = 0;
    lastInitError = null;
    lastInitAt = null;
    lastReadyAt = null;
    constructor() {
        // In tests, avoid network calls and event loop handles
        if (process.env.NODE_ENV === 'test') {
            // Minimal no-op initialization
            // Use dummy provider/signer to satisfy types, but do not call RPC
            // Note: we intentionally don't construct contracts or run init()
            this.provider = new ethers_1.ethers.JsonRpcProvider('http://localhost:0');
            // Generate a throwaway wallet not connected to provider
            this.signer = new ethers_1.ethers.Wallet(ethers_1.ethers.hexlify(ethers_1.ethers.randomBytes(32)));
            this.channelManager = {};
            this.vault = {};
            this.token = {};
            this.adjudicator = {};
            this.ready = true;
            logger_1.logger.info('Sepolia channel service initialized (test mode)');
            return;
        }
        // Validate required Sepolia envs
        if (!environment_1.env.blockchain.rpcProvider)
            throw new Error('JSON_RPC_PROVIDER is required');
        if (!environment_1.env.blockchain.adminPrivateKey)
            throw new Error('ADMIN_PRIVATE_KEY is required');
        if (!environment_1.env.blockchain.creatorVaultAddress)
            throw new Error('CREATOR_VAULT_ADDRESS is required');
        if (!environment_1.env.nitrolite?.custody)
            throw new Error('NITROLITE_CUSTODY_ADDRESS is required');
        if (!environment_1.env.nitrolite?.token)
            throw new Error('NITROLITE_TOKEN_ADDRESS is required');
        if (!environment_1.env.nitrolite?.adjudicator)
            throw new Error('NITROLITE_ADJUDICATOR_ADDRESS is required');
        if (environment_1.env.yellow.chainId !== 11155111)
            throw new Error('CHANNEL_CHAIN_ID must be 11155111 (Sepolia)');
        this.provider = new ethers_1.ethers.JsonRpcProvider(environment_1.env.blockchain.rpcProvider);
        this.signer = new ethers_1.ethers.Wallet(environment_1.env.blockchain.adminPrivateKey, this.provider);
        // Initialize contracts & validate bytecode exists (lazy, non-fatal at startup)
        this.channelManager = new ethers_1.ethers.Contract(environment_1.env.nitrolite.custody, ChannelManager_json_1.default.abi, this.signer);
        this.vault = new ethers_1.ethers.Contract(environment_1.env.blockchain.creatorVaultAddress, Nitrolite_1.default.abi, this.signer);
        this.token = new ethers_1.ethers.Contract(environment_1.env.nitrolite.token, NitroliteToken_json_1.default.abi, this.signer);
        this.adjudicator = new ethers_1.ethers.Contract(environment_1.env.nitrolite.adjudicator, Adjudicator_json_1.default.abi, this.signer);
        this.init();
        logger_1.logger.info('Sepolia channel service initialized (ethers.js)');
    }
    init() {
        if (this.initPromise)
            return this.initPromise;
        this.initAttempts += 1;
        this.lastInitAt = Date.now();
        const fetchCodes = async () => {
            const attempt = async (fn, label, tries = 3) => {
                let lastErr;
                for (let i = 0; i < tries; i++) {
                    try {
                        return await fn();
                    }
                    catch (e) {
                        lastErr = e;
                        const transient = /ECONNRESET|socket hang up|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH/i.test(e?.message || '');
                        if (!transient)
                            break;
                        const delay = 400 * (i + 1);
                        logger_1.logger.warn({ err: e?.message, attempt: i + 1, delay, label }, 'Transient RPC error; retrying');
                        await new Promise(r => setTimeout(r, delay));
                    }
                }
                throw lastErr;
            };
            return Promise.all([
                attempt(() => this.provider.getCode(environment_1.env.nitrolite.custody), 'custody'),
                attempt(() => this.provider.getCode(environment_1.env.blockchain.creatorVaultAddress), 'vault'),
                attempt(() => this.provider.getCode(environment_1.env.nitrolite.token), 'token'),
                attempt(() => this.provider.getCode(environment_1.env.nitrolite.adjudicator), 'adjudicator'),
            ]);
        };
        this.initPromise = fetchCodes()
            .then(([chanCode, vaultCode, tokenCode, adjCode]) => {
            if (chanCode === '0x') {
                logger_1.logger.error('No code at NITROLITE_CUSTODY_ADDRESS – deploy ChannelManager and update env');
                this.ready = false;
                this.lastInitError = 'missing_channel_manager_code';
                return;
            }
            if (vaultCode === '0x') {
                logger_1.logger.error('No code at CREATOR_VAULT_ADDRESS – deploy Nitrolite and update env');
                this.ready = false;
                this.lastInitError = 'missing_vault_code';
                return;
            }
            if (tokenCode === '0x') {
                logger_1.logger.error('No code at NITROLITE_TOKEN_ADDRESS – deploy token and update env');
                this.ready = false;
                this.lastInitError = 'missing_token_code';
                return;
            }
            if (adjCode === '0x') {
                logger_1.logger.error('No code at NITROLITE_ADJUDICATOR_ADDRESS – deploy adjudicator and update env');
                this.ready = false;
                this.lastInitError = 'missing_adjudicator_code';
                return;
            }
            this.ready = true;
            this.lastReadyAt = Date.now();
            this.lastInitError = null;
            logger_1.logger.info('Sepolia contracts found, nitrolite service ready');
            // Fetch admin signer balance for diagnostics
            this.signer.getAddress().then(addr => this.provider.getBalance(addr).then(bal => {
                const eth = Number(ethers_1.ethers.formatEther(bal));
                if (eth < 0.001) {
                    logger_1.logger.warn({ address: addr, balanceEth: eth }, 'Admin signer low balance; on-chain channel open may fail');
                }
                else {
                    logger_1.logger.info({ address: addr, balanceEth: eth }, 'Admin signer funded');
                }
            })).catch(err => logger_1.logger.warn({ err: err?.message }, 'Failed to fetch admin signer balance'));
        })
            .catch((e) => {
            this.ready = false;
            this.lastInitError = e?.message || 'init_failed';
            logger_1.logger.error({ err: this.lastInitError, attempts: this.initAttempts }, 'Contract code validation failed (will retry on next demand)');
            // Critical: allow subsequent calls to init() to retry by clearing cached promise
            this.initPromise = null;
        });
        return this.initPromise;
    }
    isReady() { return this.ready; }
    async ensureReady() {
        if (this.ready)
            return true;
        await this.init();
        return this.ready;
    }
    // Validate a viewer-submitted openChannel transaction and ensure it matches expected args/value
    async validateOpenTx(txHash, viewer, streamIdOrSalted, vaultId, depositWei) {
        if (!await this.ensureReady())
            throw new Error('ChannelManager not ready. Deploy contracts and set env.');
        const tx = await this.provider.getTransaction(txHash);
        if (!tx)
            throw new Error('open tx not found');
        if ((tx.to || '').toLowerCase() !== String(this.channelManager.target).toLowerCase())
            throw new Error('tx to wrong contract');
        if (tx.value !== depositWei)
            throw new Error('tx value mismatch');
        // Decode call data
        const parsed = this.channelManager.interface.parseTransaction({ data: tx.data, value: tx.value });
        if (!parsed || parsed.name !== 'openChannel')
            throw new Error('not an openChannel call');
        const [argViewer, argStreamIdHash, argVaultId] = parsed.args;
        // streamIdOrSalted may include ":salt" suffix for forced-new channels
        const expectedHash = ethers_1.ethers.id(streamIdOrSalted);
        if (String(argViewer).toLowerCase() !== viewer.toLowerCase())
            throw new Error('viewer mismatch');
        if (String(argStreamIdHash).toLowerCase() !== expectedHash.toLowerCase())
            throw new Error('streamId hash mismatch');
        if (BigInt(argVaultId) !== BigInt(vaultId))
            throw new Error('vaultId mismatch');
        // Ensure it’s mined and successful
        const rc = await this.provider.waitForTransaction(txHash, 1, 60_000);
        if (!rc || Number(rc.status ?? 0) !== 1)
            throw new Error('open tx failed');
        return { ok: true };
    }
    // On-chain open channel tx
    async openChannel(viewer, streamIdOrSalted, vaultId, depositWei) {
        if (!await this.ensureReady())
            throw new Error('ChannelManager not ready. Deploy contracts and set env.');
        const streamIdHash = ethers_1.ethers.id(streamIdOrSalted);
        const tx = await this.channelManager.openChannel(viewer, streamIdHash, vaultId, { value: depositWei });
        const rcpt = await tx.wait(1);
        return { txHash: rcpt.hash || tx.hash };
    }
    // On-chain close channel settlement
    async closeChannel(channelId, spentWei) {
        if (!await this.ensureReady())
            throw new Error('ChannelManager not ready. Deploy contracts and set env.');
        const tx = await this.channelManager.closeChannel(channelId, spentWei);
        const rcpt = await tx.wait(1);
        return { txHash: rcpt.hash || tx.hash };
    }
    async depositToVault(vaultId, amount) {
        const tx = await this.vault.deposit(vaultId, { value: amount });
        const rc = await tx.wait(1);
        return rc.hash || tx.hash;
    }
    async adjudicate(state, signature) {
        // Dev fallback when contracts aren’t ready or RPC not available
        if (!this.ready && process.env.NODE_ENV !== 'production') {
            const mock = ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes(`mock-adjudicate:${JSON.stringify(state)}:${signature}:${Date.now()}`));
            logger_1.logger.warn({ tx: mock }, 'Dev mode: adjudicate fallback (contracts not ready)');
            return mock;
        }
        try {
            if (!await this.ensureReady())
                throw new Error('Adjudicator not ready');
            // Coerce potential string inputs to bigint for contract call
            const normalized = {
                channelId: state.channelId,
                vaultId: BigInt(state.vaultId),
                viewer: state.viewer,
                deposit: BigInt(state.deposit),
                spent: BigInt(state.spent),
                nonce: BigInt(state.nonce),
            };
            const tx = await this.adjudicator.adjudicate(normalized, signature, state.viewer);
            const rc = await tx.wait(1);
            return rc.hash || tx.hash;
        }
        catch (e) {
            if (process.env.NODE_ENV !== 'production') {
                const mock = ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes(`mock-adjudicate-error:${JSON.stringify(state)}:${signature}:${Date.now()}`));
                logger_1.logger.warn({ err: e?.message, tx: mock }, 'Dev mode: adjudicate failed; returning mock tx');
                return mock;
            }
            throw e;
        }
    }
    // Read on-chain channel mapping for diagnostics
    async getOnchainChannel(channelId) {
        if (!this.ready) {
            await this.init();
        }
        if (!this.ready)
            return null;
        try {
            const ch = await this.channelManager.channels(channelId);
            if (!ch)
                return null;
            return {
                viewer: String(ch.viewer),
                vaultId: String(ch.vaultId?.toString?.() ?? ch.vaultId),
                deposit: String(ch.deposit?.toString?.() ?? ch.deposit),
                spent: String(ch.spent?.toString?.() ?? ch.spent),
                closed: Boolean(ch.closed),
            };
        }
        catch (e) {
            logger_1.logger.warn({ err: e?.message }, 'getOnchainChannel failed');
            return null;
        }
    }
    async getAdminStatus() {
        try {
            const addr = await this.signer.getAddress();
            let balStr = null;
            let balEth = null;
            try {
                const bal = await this.provider.getBalance(addr);
                balStr = bal.toString();
                balEth = ethers_1.ethers.formatEther(bal);
            }
            catch (balanceErr) {
                logger_1.logger.warn({ err: balanceErr?.message }, 'Failed to fetch admin balance');
            }
            return { address: addr, balanceWei: balStr, balanceEth: balEth, ready: this.ready };
        }
        catch (e) {
            return { address: null, error: e.message, ready: this.ready };
        }
    }
    getStatus() {
        return {
            ready: this.ready,
            attempts: this.initAttempts,
            lastInitAt: this.lastInitAt,
            lastReadyAt: this.lastReadyAt,
            lastInitError: this.lastInitError,
        };
    }
}
exports.yellowService = new YellowService();
//# sourceMappingURL=yellow.service.js.map
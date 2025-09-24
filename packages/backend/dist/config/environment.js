"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.env = void 0;
const zod_1 = require("zod");
require("dotenv/config"); // Ensures .env file is loaded and available to process.env
/**
 * Defines the schema for all environment variables used by the application.
 * This provides validation and type safety. The application will fail to start
 * if any required variables are missing or have the wrong type, preventing
 * misconfiguration errors in production.
 */
const envSchema = zod_1.z.object({
    // --- Core & Database ---
    PORT: zod_1.z.coerce.number().default(8000),
    // Enhanced MongoDB URL validation
    DATABASE_URL: zod_1.z.string()
        .min(1, 'DATABASE_URL is required')
        .refine((url) => {
        return url.startsWith('mongodb://') || url.startsWith('mongodb+srv://');
    }, 'DATABASE_URL must be a valid MongoDB connection string'),
    // Optional explicit DB name if the URI omits it (e.g. ends with /?query...)
    MONGO_DB_NAME: zod_1.z.string().optional(),
    // --- Authentication ---
    JWT_SECRET: zod_1.z.string().min(1, 'JWT_SECRET is a required environment variable.'),
    JWT_EXPIRES_IN: zod_1.z.string().default('1d'),
    GOOGLE_CLIENT_ID: zod_1.z.string().optional(),
    GOOGLE_CLIENT_SECRET: zod_1.z.string().optional(),
    // --- Blockchain (Web3) ---
    JSON_RPC_PROVIDER: zod_1.z.string().url('JSON_RPC_PROVIDER must be a valid RPC URL.'),
    CREATOR_VAULT_ADDRESS: zod_1.z.string().startsWith('0x', 'Contract address must be a valid hex string.'),
    ADMIN_PRIVATE_KEY: zod_1.z.string().startsWith('0x', 'Admin private key must be a valid hex string.')
        .refine(v => !/^0x0+$/.test(v), 'ADMIN_PRIVATE_KEY cannot be all zeros placeholder'),
    // Contract deploy block to bound event scans (required)
    NITROLITE_DEPLOY_BLOCK: zod_1.z.coerce.number().int().nonnegative(),
    // --- Payments ---
    STRIPE_SECRET_KEY: zod_1.z.string().optional(),
    // --- Channel settlement / Sepolia-only config ---
    // Deployed on-chain addresses (required)
    NITROLITE_TOKEN_ADDRESS: zod_1.z.string().startsWith('0x').length(42),
    NITROLITE_CUSTODY_ADDRESS: zod_1.z.string().startsWith('0x').length(42),
    NITROLITE_ADJUDICATOR_ADDRESS: zod_1.z.string().startsWith('0x').length(42),
    // Chain id must be Sepolia
    CHANNEL_CHAIN_ID: zod_1.z.coerce.number().refine((n) => n === 11155111, {
        message: 'CHANNEL_CHAIN_ID must be 11155111 (Sepolia)'
    }),
    MIN_CHANNEL_DEPOSIT_WEI: zod_1.z.coerce.number().optional(),
    MIN_TIP_WEI: zod_1.z.coerce.number().optional(),
    // --- CORS / Frontend ---
    CORS_ORIGIN: zod_1.z.string().optional(),
    // --- Node Media Server (Streaming) ---
    NMS_RTMP_URL: zod_1.z.string().url().default('rtmp://localhost:1935/live'),
    NMS_HLS_BASE: zod_1.z.string().url().default('http://localhost:8081'),
    NMS_HLS_TEMPLATE: zod_1.z.string().default('/live/{key}/index.m3u8'),
    // --- Indexer & Metadata ---
    IPFS_GATEWAY: zod_1.z.string().url().optional(),
    INDEXER_BATCH_SIZE: zod_1.z.coerce.number().optional(),
    INDEXER_REORG_DEPTH: zod_1.z.coerce.number().optional(),
    // --- Optional pinning (Pinata) ---
    PINATA_JWT: zod_1.z.string().optional(),
    PIN_ON_METADATA_FETCH: zod_1.z.enum(['true', 'false']).optional(),
});
// Parse and validate the environment variables from `process.env`
const parsedEnv = envSchema.parse(process.env);
// Defensive runtime guard: if someone provides a PostgreSQL-like URL, fail fast with clear message
if (process.env.DATABASE_URL && /^(postgres|mysql|mssql):\/\//i.test(process.env.DATABASE_URL)) {
    // eslint-disable-next-line no-console
    console.error('\nFATAL: DATABASE_URL appears to be a SQL connection string but this service uses MongoDB.');
    console.error('Provided DATABASE_URL=', process.env.DATABASE_URL);
    console.error('Expected format: mongodb://user:password@host:27017/dbname?authSource=admin');
    process.exit(1);
}
// Export a structured, type-safe object that mirrors your original structure for easy access
exports.env = {
    port: parsedEnv.PORT,
    databaseUrl: parsedEnv.DATABASE_URL,
    mongoDbName: parsedEnv.MONGO_DB_NAME,
    jwt: {
        secret: parsedEnv.JWT_SECRET,
        expiresIn: parsedEnv.JWT_EXPIRES_IN,
    },
    google: {
        clientId: parsedEnv.GOOGLE_CLIENT_ID,
        clientSecret: parsedEnv.GOOGLE_CLIENT_SECRET,
    },
    blockchain: {
        rpcProvider: parsedEnv.JSON_RPC_PROVIDER,
        creatorVaultAddress: parsedEnv.CREATOR_VAULT_ADDRESS,
        adminPrivateKey: parsedEnv.ADMIN_PRIVATE_KEY,
        deployFromBlock: parsedEnv.NITROLITE_DEPLOY_BLOCK,
    },
    stripe: {
        secretKey: parsedEnv.STRIPE_SECRET_KEY,
    },
    yellow: {
        // Retain object shape for existing imports; rename semantics to nitrolite stack
        channelContract: parsedEnv.NITROLITE_CUSTODY_ADDRESS,
        chainId: parsedEnv.CHANNEL_CHAIN_ID,
        minChannelDepositWei: parsedEnv.MIN_CHANNEL_DEPOSIT_WEI || 100000000000000n,
        minTipWei: parsedEnv.MIN_TIP_WEI || 100000000000n,
    },
    nitrolite: {
        token: parsedEnv.NITROLITE_TOKEN_ADDRESS,
        custody: parsedEnv.NITROLITE_CUSTODY_ADDRESS,
        adjudicator: parsedEnv.NITROLITE_ADJUDICATOR_ADDRESS,
        vault: parsedEnv.CREATOR_VAULT_ADDRESS,
    },
    corsOrigin: parsedEnv.CORS_ORIGIN,
    nms: {
        rtmpUrl: parsedEnv.NMS_RTMP_URL,
        hlsBase: parsedEnv.NMS_HLS_BASE,
        hlsTemplate: parsedEnv.NMS_HLS_TEMPLATE,
    },
    ipfsGateway: parsedEnv.IPFS_GATEWAY || 'https://ipfs.io',
    indexer: {
        batchSize: parsedEnv.INDEXER_BATCH_SIZE ?? 5000,
        reorgDepth: parsedEnv.INDEXER_REORG_DEPTH ?? 6,
    },
    pinata: {
        jwt: parsedEnv.PINATA_JWT,
        pinOnMetadataFetch: parsedEnv.PIN_ON_METADATA_FETCH === 'true',
    },
};
//# sourceMappingURL=environment.js.map
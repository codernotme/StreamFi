import { z } from 'zod';
import 'dotenv/config'; // Ensures .env file is loaded and available to process.env

/**
 * Defines the schema for all environment variables used by the application.
 * This provides validation and type safety. The application will fail to start
 * if any required variables are missing or have the wrong type, preventing
 * misconfiguration errors in production.
 */
const envSchema = z.object({
  // --- Core & Database ---
  PORT: z.coerce.number().default(8000),
  // Enhanced MongoDB URL validation
  DATABASE_URL: z.string()
    .min(1, 'DATABASE_URL is required')
    .refine((url) => {
      return url.startsWith('mongodb://') || url.startsWith('mongodb+srv://');
    }, 'DATABASE_URL must be a valid MongoDB connection string'),
  // Optional explicit DB name if the URI omits it (e.g. ends with /?query...)
  MONGO_DB_NAME: z.string().optional(),
  
  // --- Authentication ---
  JWT_SECRET: z.string().min(1, 'JWT_SECRET is a required environment variable.'),
  JWT_EXPIRES_IN: z.string().default('1d'),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  // --- Blockchain (Web3) ---
  JSON_RPC_PROVIDER: z.string().url('JSON_RPC_PROVIDER must be a valid RPC URL.'),
  CREATOR_VAULT_ADDRESS: z.string().startsWith('0x', 'Contract address must be a valid hex string.'),
  ADMIN_PRIVATE_KEY: z.string().startsWith('0x', 'Admin private key must be a valid hex string.'),
  // Optional contract deploy block to bound event scans
  NITROLITE_DEPLOY_BLOCK: z.coerce.number().optional(),

  // --- Payments ---
  STRIPE_SECRET_KEY: z.string().optional(),

  // --- Yellow SDK / API ---
  YELLOW_API_KEY: z.string().min(1, 'YELLOW_API_KEY is required.'),
  YELLOW_ENVIRONMENT: z.enum(['mainnet', 'testnet']).default('testnet'),

  // --- CORS / Frontend ---
  CORS_ORIGIN: z.string().optional(),

  // --- Node Media Server (Streaming) ---
  NMS_RTMP_URL: z.string().url().default('rtmp://localhost:1935/live'),
  NMS_HLS_BASE: z.string().url().default('http://localhost:8081'),
  NMS_HLS_TEMPLATE: z.string().default('/live/{key}/index.m3u8'),
  // --- Indexer & Metadata ---
  IPFS_GATEWAY: z.string().url().optional(),
  INDEXER_BATCH_SIZE: z.coerce.number().optional(),
  INDEXER_REORG_DEPTH: z.coerce.number().optional(),
  // --- Optional pinning (Pinata) ---
  PINATA_JWT: z.string().optional(),
  PIN_ON_METADATA_FETCH: z.enum(['true','false']).optional(),
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
export const env = {
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
  deployFromBlock: parsedEnv.NITROLITE_DEPLOY_BLOCK ?? 0,
  },
  stripe: {
    secretKey: parsedEnv.STRIPE_SECRET_KEY,
  },
  yellow: {
    apiKey: parsedEnv.YELLOW_API_KEY,
    environment: parsedEnv.YELLOW_ENVIRONMENT,
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


import app from './app';
import http from 'http';
import { Server as SocketIOServer, type ServerOptions } from 'socket.io';
import { logger } from './utils/logger';
import { onSocketConnection } from './services/overlay.service';
import { setSocket } from './lib/socket';
import { env } from './config/environment';
import { blockchainService } from './services/blockchain.service';
import { nftIndexer } from './services/nft-indexer.service';
import { connectMongo } from './lib/mongo';
import { markReady } from './config/state';
import { clearingNodeService } from './services/clearing-node.service';

const PORT = env.port || 8000;

const httpServer = http.createServer(app);

// Global hardening: prevent process exit on transient unhandled promise rejections / exceptions.
process.on('unhandledRejection', (reason: any) => {
  logger.error({ err: reason instanceof Error ? reason.message : String(reason) }, 'UnhandledRejection (continuing)');
});
process.on('uncaughtException', (err: any) => {
  logger.error({ err: err?.message }, 'UncaughtException caught – keeping process alive');
});

/**
 * Some Socket.IO type packages (depending on version) omit `cors` in `ServerOptions`.
 * It's valid at runtime for v4+, so we cast to `any` for compatibility.
 */
const ioOptions: Partial<ServerOptions> & { cors?: any } = {
  cors: {
    origin: env.corsOrigin ? env.corsOrigin.split(',').map((s) => s.trim()) : false,
    methods: ['GET', 'POST'],
    credentials: true,
  },
};

const io = new SocketIOServer(httpServer, ioOptions);
setSocket(io);

onSocketConnection(io);

async function start() {
  let dbOk = false;
  if (process.env.NODE_ENV !== 'test') {
    try {
      await connectMongo();
      dbOk = true;
    } catch (e) {
      logger.error({ err: e }, 'Failed initial MongoDB connection');
    }
  }
  if (dbOk) markReady();
  httpServer.listen(PORT, () => {
    logger.info(`🚀 Server is running on port ${PORT}`);
    if (process.env.NODE_ENV !== 'test') {
      try { blockchainService.listenForDonations(); } catch (e) { logger.warn({ err: e }, 'Blockchain listener init failed'); }
      try { clearingNodeService.start(); } catch (e) { logger.warn({ err: e }, 'Clearing node service init failed'); }
      // nftIndexer.backfill().then(() => logger.info('✅ NFT backfill complete')).catch((e) => logger.error({ err: e }, 'NFT backfill failed'));
      // nftIndexer.subscribe();
    }
  });
}

function shutdown(signal: string) {
  logger.info(`${signal} received. Shutting down...`);
  httpServer.close(() => {
    import('mongoose').then(m => m.connection.close().catch(()=>{})).finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 8000).unref();
}
['SIGINT','SIGTERM'].forEach(sig => process.on(sig as NodeJS.Signals, () => shutdown(sig)));

start();

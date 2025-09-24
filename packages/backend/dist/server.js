"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const app_1 = __importDefault(require("./app"));
const http_1 = __importDefault(require("http"));
const socket_io_1 = require("socket.io");
const logger_1 = require("./utils/logger");
const overlay_service_1 = require("./services/overlay.service");
const socket_1 = require("./lib/socket");
const environment_1 = require("./config/environment");
const blockchain_service_1 = require("./services/blockchain.service");
const mongo_1 = require("./lib/mongo");
const state_1 = require("./config/state");
const clearing_node_service_1 = require("./services/clearing-node.service");
const PORT = environment_1.env.port || 8000;
const httpServer = http_1.default.createServer(app_1.default);
// Global hardening: prevent process exit on transient unhandled promise rejections / exceptions.
process.on('unhandledRejection', (reason) => {
    logger_1.logger.error({ err: reason instanceof Error ? reason.message : String(reason) }, 'UnhandledRejection (continuing)');
});
process.on('uncaughtException', (err) => {
    logger_1.logger.error({ err: err?.message }, 'UncaughtException caught – keeping process alive');
});
/**
 * Some Socket.IO type packages (depending on version) omit `cors` in `ServerOptions`.
 * It's valid at runtime for v4+, so we cast to `any` for compatibility.
 */
const ioOptions = {
    cors: {
        origin: environment_1.env.corsOrigin ? environment_1.env.corsOrigin.split(',').map((s) => s.trim()) : false,
        methods: ['GET', 'POST'],
        credentials: true,
    },
};
const io = new socket_io_1.Server(httpServer, ioOptions);
(0, socket_1.setSocket)(io);
(0, overlay_service_1.onSocketConnection)(io);
async function start() {
    let dbOk = false;
    if (process.env.NODE_ENV !== 'test') {
        try {
            await (0, mongo_1.connectMongo)();
            dbOk = true;
        }
        catch (e) {
            logger_1.logger.error({ err: e }, 'Failed initial MongoDB connection');
        }
    }
    if (dbOk)
        (0, state_1.markReady)();
    httpServer.listen(PORT, () => {
        logger_1.logger.info(`🚀 Server is running on port ${PORT}`);
        if (process.env.NODE_ENV !== 'test') {
            try {
                blockchain_service_1.blockchainService.listenForDonations();
            }
            catch (e) {
                logger_1.logger.warn({ err: e }, 'Blockchain listener init failed');
            }
            try {
                clearing_node_service_1.clearingNodeService.start();
            }
            catch (e) {
                logger_1.logger.warn({ err: e }, 'Clearing node service init failed');
            }
            // nftIndexer.backfill().then(() => logger.info('✅ NFT backfill complete')).catch((e) => logger.error({ err: e }, 'NFT backfill failed'));
            // nftIndexer.subscribe();
        }
    });
}
function shutdown(signal) {
    logger_1.logger.info(`${signal} received. Shutting down...`);
    httpServer.close(() => {
        import('mongoose').then(m => m.connection.close().catch(() => { })).finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 8000).unref();
}
['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => shutdown(sig)));
start();
//# sourceMappingURL=server.js.map
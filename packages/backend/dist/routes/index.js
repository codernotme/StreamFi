"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const rateLimiter_1 = require("../middlewares/rateLimiter");
const auth_routes_1 = __importDefault(require("../modules/auth/auth.routes"));
const user_routes_1 = __importDefault(require("../modules/users/user.routes"));
const stream_routes_1 = __importDefault(require("../modules/stream/stream.routes"));
const monetization_routes_1 = __importDefault(require("../modules/monetization/monetization.routes"));
const notification_routes_1 = __importDefault(require("../modules/notifications/notification.routes"));
const vault_routes_1 = __importDefault(require("../modules/vaults/vault.routes"));
const admin_routes_1 = __importDefault(require("../modules/admin/admin.routes"));
const chat_routes_1 = __importDefault(require("../modules/stream/chat.routes"));
const payments_routes_1 = __importDefault(require("../modules/monetization/payments.routes"));
const reactions_routes_1 = __importDefault(require("../modules/reactions/reactions.routes"));
const nms_routes_1 = __importDefault(require("../modules/stream/nms.routes"));
const channel_routes_1 = __importDefault(require("../modules/channels/channel.routes"));
const mongo_1 = require("../lib/mongo");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const environment_1 = require("../config/environment");
const yellow_service_1 = require("../services/yellow.service");
const clearing_node_service_1 = require("../services/clearing-node.service");
const router = (0, express_1.Router)();
router.use('/auth', rateLimiter_1.authBurstLimiter, auth_routes_1.default);
router.use('/stream', stream_routes_1.default);
router.use('/monetization', monetization_routes_1.default);
router.use('/notifications', notification_routes_1.default);
router.use('/vaults', vault_routes_1.default);
router.use('/admin', admin_routes_1.default);
router.use('/chat', chat_routes_1.default);
router.use('/users', user_routes_1.default);
router.use('/payments', rateLimiter_1.authBurstLimiter, payments_routes_1.default);
router.use('/reactions', reactions_routes_1.default);
router.use('/nms', nms_routes_1.default);
router.use('/channels', channel_routes_1.default);
// Nitrolite readiness before export (ensure route registration)
router.get('/debug/nitrolite', async (_req, res) => {
    try {
        const ready = yellow_service_1.yellowService.isReady?.() ?? false;
        const admin = await yellow_service_1.yellowService.getAdminStatus?.();
        const out = {
            ready,
            chainId: environment_1.env.yellow.chainId,
            custody: environment_1.env.nitrolite.custody,
            adjudicator: environment_1.env.nitrolite.adjudicator,
            token: environment_1.env.nitrolite.token,
            vault: environment_1.env.nitrolite.vault,
            admin,
        };
        return res.json(out);
    }
    catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});
// Check on-chain channel by id
router.get('/debug/channel/:id', async (req, res) => {
    try {
        const id = req.params.id;
        const onchain = await yellow_service_1.yellowService.getOnchainChannel(id);
        return res.json({ ok: true, onchain });
    }
    catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});
// Lightweight diagnostic endpoint (non-sensitive). Remove in production.
router.get('/debug/db', async (_req, res) => {
    try {
        const conn = await (0, mongo_1.connectMongo)();
        const state = conn.readyState; // 1 = connected
        const userCount = await mongo_1.UserModel.estimatedDocumentCount();
        return res.json({ ok: true, state, userCount, db: conn.name });
    }
    catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});
// Quick auth debug: verifies a provided token (Authorization: Bearer <token>)
router.get('/debug/auth', async (req, res) => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer '))
        return res.status(400).json({ ok: false, error: 'Missing bearer token' });
    const token = auth.slice(7);
    try {
        const decoded = jsonwebtoken_1.default.verify(token, environment_1.env.jwt.secret);
        const user = await mongo_1.UserModel.findById(decoded.id).select('email role').lean();
        return res.json({ ok: true, decoded: { id: decoded.id, role: decoded.role }, exists: !!user });
    }
    catch (e) {
        return res.status(401).json({ ok: false, error: e.message });
    }
});
exports.default = router;
// P2P helper routes (non-auth for local testing; tighten later)
router.get('/p2p/health', (_req, res) => {
    return res.json({ ok: true, ...clearing_node_service_1.clearingNodeService.getHealth() });
});
router.get('/p2p/latest/:channelId', (req, res) => {
    const out = clearing_node_service_1.clearingNodeService.getLatest(req.params.channelId);
    return res.json({ ok: true, latest: out });
});
router.post('/p2p/publish', async (req, res) => {
    try {
        const { topic, envelope } = req.body || {};
        const ok = await clearing_node_service_1.clearingNodeService.publish(String(topic || ''), envelope);
        return res.json({ ok });
    }
    catch (e) {
        return res.status(400).json({ ok: false, error: e.message });
    }
});
//# sourceMappingURL=index.js.map
import { Router } from 'express';
import { authBurstLimiter } from '../middlewares/rateLimiter';
import authRoutes from '../modules/auth/auth.routes';
import userRoutes from '../modules/users/user.routes';
import streamRoutes from '../modules/stream/stream.routes';
import monetizationRoutes from '../modules/monetization/monetization.routes';
import notificationRoutes from '../modules/notifications/notification.routes';
import vaultRoutes from '../modules/vaults/vault.routes'; 
import adminRoutes from '../modules/admin/admin.routes';
import chatRoutes from '../modules/stream/chat.routes';
import paymentsRoutes from '../modules/monetization/payments.routes';
import reactionsRoutes from '../modules/reactions/reactions.routes';
import nmsRoutes from '../modules/stream/nms.routes';
import channelRoutes from '../modules/channels/channel.routes';
import { connectMongo, UserModel } from '../lib/mongo';
import jwt from 'jsonwebtoken';
import { env } from '../config/environment';
import { yellowService } from '../services/yellow.service';
import { clearingNodeService } from '../services/clearing-node.service';

const router = Router();
router.use('/auth', authBurstLimiter, authRoutes);
router.use('/stream', streamRoutes);
router.use('/monetization', monetizationRoutes);
router.use('/notifications', notificationRoutes);
router.use('/vaults', vaultRoutes);
router.use('/admin', adminRoutes);
router.use('/chat', chatRoutes);
router.use('/users', userRoutes);
router.use('/payments', authBurstLimiter, paymentsRoutes);
router.use('/reactions', reactionsRoutes);
router.use('/nms', nmsRoutes);
router.use('/channels', channelRoutes);

// Nitrolite readiness before export (ensure route registration)
router.get('/debug/nitrolite', async (_req, res) => {
	try {
		const ready = yellowService.isReady?.() ?? false;
		const admin = await yellowService.getAdminStatus?.();
		const out = {
			ready,
			chainId: env.yellow.chainId,
			custody: env.nitrolite.custody,
			adjudicator: env.nitrolite.adjudicator,
			token: env.nitrolite.token,
			vault: env.nitrolite.vault,
			admin,
		};
		return res.json(out);
	} catch (e: any) {
		return res.status(500).json({ ok: false, error: e.message });
	}
});

// Check on-chain channel by id
router.get('/debug/channel/:id', async (req, res) => {
	try {
		const id = req.params.id;
		const onchain = await yellowService.getOnchainChannel(id);
		return res.json({ ok: true, onchain });
	} catch (e: any) {
		return res.status(500).json({ ok: false, error: e.message });
	}
});

// Lightweight diagnostic endpoint (non-sensitive). Remove in production.
router.get('/debug/db', async (_req, res) => {
	try {
		const conn = await connectMongo();
		const state = conn.readyState; // 1 = connected
		const userCount = await UserModel.estimatedDocumentCount();
		const host = (conn as any).client?.options?.hosts || (conn as any).client?.s?.hosts || undefined;
		const url = process.env.DATABASE_URL || undefined;
		return res.json({ ok: true, state, userCount, db: conn.name, host, url });
	} catch (e: any) {
		return res.status(500).json({ ok: false, error: e.message });
	}
});

// Quick auth debug: verifies a provided token (Authorization: Bearer <token>)
router.get('/debug/auth', async (req, res) => {
	const auth = req.headers.authorization;
	if (!auth?.startsWith('Bearer ')) return res.status(400).json({ ok: false, error: 'Missing bearer token' });
	const token = auth.slice(7);
	try {
		const decoded = jwt.verify(token, env.jwt.secret) as any;
		const user = await UserModel.findById(decoded.id).select('email role').lean();
		return res.json({ ok: true, decoded: { id: decoded.id, role: decoded.role }, exists: !!user });
	} catch (e: any) {
		return res.status(401).json({ ok: false, error: e.message });
	}
});

export default router;

// P2P helper routes (non-auth for local testing; tighten later)
router.get('/p2p/health', (_req, res) => {
	return res.json({ ok: true, ...clearingNodeService.getHealth() })
})
router.get('/p2p/latest/:channelId', (req, res) => {
	const out = clearingNodeService.getLatest(req.params.channelId)
	return res.json({ ok: true, latest: out })
})
router.post('/p2p/publish', async (req, res) => {
	try {
		const { topic, envelope } = req.body || {}
		const ok = await clearingNodeService.publish(String(topic || ''), envelope)
		return res.json({ ok })
	} catch (e: any) {
		return res.status(400).json({ ok: false, error: e.message })
	}
})
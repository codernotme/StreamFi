import { Router } from 'express';
import { authMiddleware } from '../../middlewares/auth.middleware';
import mongoose from 'mongoose';
import { openChannel, verifyAndApplyTip, closeChannelCooperative } from '../../services/channel.service';
import { yellowService } from '../../services/yellow.service';
import { env } from '../../config/environment';
import { emitToStream } from '../../lib/socket';
import { ChannelModel, connectMongo } from '../../lib/mongo';
import { blockchainService } from '../../services/blockchain.service';
import { ethers } from 'ethers';

const router = Router();

// PUBLIC: Lightweight stream/channel config for viewers.
// Accepts either the Mongo _id or the public streamKey.
// Does NOT require authentication so that anonymous viewers can load the watch page.
router.get('/stream/:streamId/init', async (req, res) => {
  try {
    const maybeUser = (req as any).user; // may be undefined when not authenticated
    await connectMongo();
    const { StreamModel, UserModel } = await import('../../lib/mongo.js');
    const sid = req.params.streamId;
    // Handle 24-hex streamKey vs ObjectId collision: try byId first, then fall back to streamKey when not found
    let stream: any = null;
    if (mongoose.Types.ObjectId.isValid(sid)) {
      stream = await StreamModel.findById(sid).lean();
      if (!stream) {
        stream = await StreamModel.findOne({ streamKey: sid }).lean();
      }
    } else {
      stream = await StreamModel.findOne({ streamKey: sid }).lean();
    }
    if (!stream) return res.status(404).json({ message: 'stream not found' });
    let streamer: any = await UserModel.findById((stream as any).streamerId).lean();
    let vaultId = (streamer as any)?.vaultId ?? null;
    // Auto-discover and attach vault in dev if missing but wallet is set
    if (!vaultId && (streamer as any)?.walletAddress) {
      try {
        const owned = await blockchainService.getTokensByOwner((streamer as any).walletAddress);
        if (owned && owned.length > 0) {
          vaultId = owned[0];
          await UserModel.updateOne({ _id: (streamer as any)._id }, { $set: { vaultId: vaultId.toString() } });
          streamer = await UserModel.findById((stream as any).streamerId).lean();
        }
      } catch {}
    }
    // Dev fallback: if still missing, synthesize a deterministic mock vault id to unblock local flows
    if (!vaultId && process.env.NODE_ENV !== 'production') {
      try {
        const src = String((streamer as any)?.walletAddress || (stream as any)?._id || sid).toLowerCase();
        const { ethers } = await import('ethers');
        const h = ethers.keccak256(ethers.toUtf8Bytes(src));
        const v = (BigInt(h) & ((1n << 56n) - 1n)).toString();
        await UserModel.updateOne({ _id: (streamer as any)._id }, { $set: { vaultId: v } });
        vaultId = v;
      } catch {}
    }
    return res.json({
      streamId: sid,
      vaultId,
      channelContract: env.yellow.channelContract,
      chainId: env.yellow.chainId,
      minDepositWei: env.yellow.minChannelDepositWei.toString?.() || String(env.yellow.minChannelDepositWei),
      minTipWei: env.yellow.minTipWei.toString?.() || String(env.yellow.minTipWei),
      viewerHasWallet: !!(maybeUser?.walletAddress),
    });
  } catch (e: any) { return res.status(500).json({ message: e.message }); }
});

// Everything else requires authentication
router.use(authMiddleware);
// DEV ONLY: force delete an existing channel to allow reopening with a different viewer
if (process.env.NODE_ENV !== 'production') {
  router.delete('/:id', async (req, res) => {
    try {
      await connectMongo();
      const ch = await ChannelModel.findOne({ channelId: req.params.id }).lean();
      if (!ch) return res.status(404).json({ message: 'not found' });
      if ((ch as any).status === 'OPEN') {
        await ChannelModel.deleteOne({ channelId: req.params.id });
        return res.json({ ok: true, deleted: true });
      }
      return res.status(400).json({ message: 'cannot delete non-OPEN channel' });
    } catch (e: any) { return res.status(500).json({ message: e.message }); }
  });
}

// Simple in-memory rate limiter for tips (per viewer+channel) to prevent spam
const tipRateLimiter = (() => {
  const WINDOW_MS = 5000; // 5s window
  const MAX_EVENTS = 15; // max tips per window
  const buckets = new Map<string, { count: number; ts: number }>();
  return (req: any, res: any, next: any) => {
    const viewer = (req.user?.walletAddress || req.user?.address || 'unknown').toLowerCase();
    const channelId = req.params.id || req.body?.channelId || 'none';
    const key = viewer + ':' + channelId;
    const now = Date.now();
    const entry = buckets.get(key);
    if (!entry || now - entry.ts > WINDOW_MS) {
      buckets.set(key, { count: 1, ts: now });
      return next();
    }
    if (entry.count >= MAX_EVENTS) {
      return res.status(429).json({ message: 'tip rate exceeded' });
    }
    entry.count++;
    return next();
  };
})();

// (moved above and made public)

// POST /channels/open { streamId, depositWei }
router.post('/open', async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user) return res.status(401).json({ message: 'unauthorized' });
    const { streamId, depositWei, viewer: viewerOverride } = req.body as { streamId: string; depositWei: string; viewer?: string };
    if (!streamId || !depositWei) return res.status(400).json({ message: 'streamId & depositWei required' });
    const bn = BigInt(depositWei);
    if (bn < BigInt(env.yellow.minChannelDepositWei)) return res.status(400).json({ message: 'deposit below minimum' });
    // Prefer explicit viewer override if provided and looks like an address; else fallback to authenticated user's wallet
    const headerViewer = String(req.headers['x-viewer-address'] || '').toLowerCase();
    const viewer = (viewerOverride?.toLowerCase() && viewerOverride.startsWith('0x')
      ? viewerOverride.toLowerCase()
      : (headerViewer.startsWith('0x') ? headerViewer : (user.walletAddress || user.address || '')).toLowerCase());
    if (!viewer.startsWith('0x')) return res.status(400).json({ message: 'viewer wallet missing' });
    let opened = await openChannel({ viewer, streamId, depositWei: bn });
    // If server indicates reuse, but the record is CLOSED/CLOSING, re-open it by resetting state
    if (opened.reused) {
      await connectMongo();
      const existing: any = await ChannelModel.findOne({ channelId: opened.channelId }).lean();
      if (existing && existing.status !== 'OPEN') {
        await ChannelModel.updateOne(
          { channelId: opened.channelId },
          {
            $set: {
              status: 'OPEN',
              depositWei: bn.toString(),
              spentWei: '0',
              nonce: 0,
            },
            $unset: { lastSig: "" },
          }
        );
        opened = { ...opened, reused: false, record: { ...existing, streamerVaultId: existing.streamerVaultId } } as any;
      }
    }
    // Fire on-chain openChannel tx (admin signer) only when newly created
    let txHash: string | null = null;
    if (!opened.reused && opened.record?.streamerVaultId) {
      const vaultId = BigInt(opened.record.streamerVaultId);
      try {
        const onchain = await yellowService.openChannel(viewer, streamId, vaultId, bn);
        txHash = onchain.txHash;
        // Persist the open transaction hash so we know this channel exists on-chain
        try {
          await ChannelModel.updateOne(
            { channelId: opened.channelId },
            { $set: { openTxHash: txHash } }
          );
        } catch {}
      } catch (e) {
        // Non-fatal in dev: continue with off-chain channel even if on-chain open fails (e.g., insufficient admin funds)
        txHash = null;
      }
    }
    return res.status(200).json({
      channelId: opened.channelId,
      minTipWei: env.yellow.minTipWei,
      minDepositWei: env.yellow.minChannelDepositWei,
      chainId: env.yellow.chainId,
      contract: env.yellow.channelContract,
      reused: opened.reused,
      txHash,
    });
  } catch (e: any) {
    return res.status(500).json({ message: e.message || 'failed' });
  }
});

// GET /channels/:id
router.get('/:id', async (req, res) => {
  try {
    await connectMongo();
    const ch = await ChannelModel.findOne({ channelId: req.params.id }).lean();
    if (!ch) return res.status(404).json({ message: 'not found' });
    return res.json(ch);
  } catch (e: any) { return res.status(500).json({ message: e.message }); }
});

// POST /channels/:id/tip { newSpentWei, nonce, signature, message }
router.post('/:id/tip', tipRateLimiter, async (req, res) => {
  try {
    const user = (req as any).user;
    const { newSpentWei, nonce, signature, message, viewer: viewerOverride } = req.body as { newSpentWei: string; nonce: number; signature: string; message?: string; viewer?: string };
    if (!newSpentWei || typeof nonce !== 'number' || !signature) return res.status(400).json({ message: 'missing fields' });
    const headerViewer = String(req.headers['x-viewer-address'] || '').toLowerCase();
    const viewer = (viewerOverride?.toLowerCase() && viewerOverride.startsWith('0x')
      ? viewerOverride.toLowerCase()
      : (headerViewer.startsWith('0x') ? headerViewer : (user.walletAddress||user.address||'')).toLowerCase());
    const result = await verifyAndApplyTip({ channelId: req.params.id, newSpentWei, nonce, signature, viewer, message });
    // Broadcast superchat event (cumulative tip state)
    const ch: any = await ChannelModel.findOne({ channelId: req.params.id }).lean();
    if (ch?.streamId) {
  const tipAmountEth = Number(ethers.formatEther(BigInt(result.tipWei)));
  const cumulativeEth = Number(ethers.formatEther(BigInt(result.newSpentWei)));
      let tier = 0;
      if (cumulativeEth >= 0.05) tier = 3; else if (cumulativeEth >= 0.01) tier = 2; else if (cumulativeEth >= 0.001) tier = 1;
      emitToStream(String(ch.streamId), 'superchat', {
        channelId: ch.channelId,
        streamId: ch.streamId,
        viewerAddress: ch.viewerAddress,
        tipWei: result.tipWei.toString(),
        cumulativeWei: result.newSpentWei.toString(),
        tipAmountEth,
        cumulativeEth,
        tier,
        message: message || '',
        nonce: result.nonce,
      });
    }
    return res.json({ ok: true, ...result });
  } catch (e: any) { return res.status(400).json({ message: e.message || 'failed' }); }
});

// POST /channels/:id/close
router.post('/:id/close', async (req, res) => {
  try {
  const out = await closeChannelCooperative(req.params.id);
  // Also close on-chain channel settlement with spentWei
  const ch: any = await ChannelModel.findOne({ channelId: req.params.id }).lean();
  const spent = BigInt(ch?.spentWei || '0');
  // If we never successfully opened on-chain (no openTxHash), skip on-chain close to avoid revert noise
  if (!ch?.openTxHash || out?.alreadyClosed) {
    return res.json({ ...out, settlementTx: ch?.closeTxHash || null, skippedOnchain: !ch?.openTxHash, alreadyClosed: !!out?.alreadyClosed });
  }
  try {
    const onchain = await yellowService.closeChannel(req.params.id, spent);
    return res.json({ ...out, settlementTx: onchain.txHash });
  } catch (e: any) {
    // If revert reason indicates it's already closed, treat as idempotent success
    const msg = e?.message || '';
    if (/closed/i.test(msg)) {
      return res.json({ ...out, settlementTx: null, alreadyClosed: true, onchainError: msg });
    }
    // Non-fatal in non-production environments: return cooperative close result even if on-chain close fails
    if (process.env.NODE_ENV !== 'production') {
      return res.json({ ...out, settlementTx: null, onchainError: e?.message || String(e) });
    }
    // In production, propagate error
    throw e;
  }
  } catch (e: any) { return res.status(400).json({ message: e.message }); }
});

// POST /channels/:id/adjudicate { state, signature }
router.post('/:id/adjudicate', async (req, res) => {
  try {
    const user = (req as any).user;
    const { state, signature } = req.body as any;
    if (!state || !signature) return res.status(400).json({ message: 'missing fields' });
    if (String(state.channelId).toLowerCase() !== String(req.params.id).toLowerCase()) return res.status(400).json({ message: 'channelId mismatch' });
    const txHash = await yellowService.adjudicate(state, signature);
    return res.json({ ok: true, txHash });
  } catch (e: any) { return res.status(400).json({ message: e.message || 'failed' }); }
});

// GET /channels/stream/:streamId/summary -> aggregate spentWei for OPEN + CLOSED channels (current state revenue)
router.get('/stream/:streamId/summary', async (req, res) => {
  try {
    await connectMongo();
    const streamId = req.params.streamId;
    const channels = await ChannelModel.find({ streamId }).lean();
    let total = 0n;
    for (const ch of channels) total += BigInt((ch as any).spentWei || '0');
    return res.json({ streamId, totalSpentWei: total.toString(), totalSpentEth: (Number(total)/1e18).toFixed(6), channelCount: channels.length });
  } catch (e: any) {
    return res.status(500).json({ message: e.message }); }
});

export default router;

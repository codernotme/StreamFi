"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { connectWallet, getAccounts } from "@/lib/wallet";
import { io, Socket } from "socket.io-client";
import Hls from "hls.js";
import { hlsUrlFor } from "@/lib/config";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, API_BASE } from "@/lib/api";
import { users } from "@/modules/users";
import { useAuthStore } from "@/stores/auth-store";
import { channels, channelTypedData } from '@/modules/channels';

export default function WatchPage() {
  const { sessionId: streamId } = useParams<{ sessionId: string }>();
  const session = useAuthStore((s) => s.session);
  const [address, setAddress] = useState<string | null>(null);
  // Credits (fiat) removed; we use ETH channel deposits instead
  const [log, setLog] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [reactionPrices, setReactionPrices] = useState<Record<string, number>>({ like: 1, haha: 1, wow: 1 });
  const [chat, setChat] = useState<Array<{ id: string; user: string; text: string; at: number }>>([]);
  const [text, setText] = useState("");
  // Lightweight animation overlays
  const [bursts, setBursts] = useState<Array<{ id: number; label: string }>>([]);
  const [chatFx, setChatFx] = useState<Array<{ id: number; text: string }>>([]);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [channelNonce, setChannelNonce] = useState<number>(0);
  const [channelSpentWei, setChannelSpentWei] = useState<string>('0');
  const [channelDepositWei, setChannelDepositWei] = useState<string>('0');
  const [channelStatus, setChannelStatus] = useState<'OPEN'|'CLOSING'|'CLOSED'|null>(null);
  const [closing, setClosing] = useState(false);
  const [opening, setOpening] = useState(false);
  const [requiredChainId, setRequiredChainId] = useState<number | null>(null);
  const [wrongNetwork, setWrongNetwork] = useState<boolean>(false);
  const [tipEth, setTipEth] = useState<string>('0.000001');
  const [vaultId, setVaultId] = useState<string>('0');
  const [channelContract, setChannelContract] = useState<string>('0x0000000000000000000000000000000000000000');
  const [minDepositWei, setMinDepositWei] = useState<string>('100000000000000');
  const [minTipWei, setMinTipWei] = useState<string>('100000000000');
  const minTipOk = ((): boolean => {
    try { return BigInt(channelSpentWei) >= BigInt(0); } catch { return true; }
  })();
  // Track if we've attempted auto-open to avoid loops
  const triedAutoOpenRef = useRef(false);

  useEffect(() => {
    getAccounts().then((a) => setAddress(a[0] ?? null)).catch(() => {});
  // keep address in sync with wallet
  const eth = (typeof window !== 'undefined' ? (window as any).ethereum : undefined);
  const onAcc = (accs: string[]) => setAddress((accs && accs[0]) ? accs[0] : null);
  if (eth?.on) eth.on('accountsChanged', onAcc);
  return () => { if (eth?.removeListener) eth.removeListener('accountsChanged', onAcc); };
  }, []);

  useEffect(() => {
    // viewer join/leave tracking when logged in
    let joined = false;
    (async () => {
      try {
        if (session?.token && streamId) {
          await users.joinStream(String(streamId));
          joined = true;
        }
      } catch {}
    })();

    // HLS playback via backend redirect (id or key supported)
  const hlsUrl = hlsUrlFor(String(streamId ?? ''));
    if (videoRef.current) {
      if (Hls.isSupported()) {
        const hls = new Hls({ maxBufferLength: 30 });
        hls.loadSource(hlsUrl);
        hls.attachMedia(videoRef.current);
        // Cleanup on unmount to avoid leaks
        return () => {
          try { hls.destroy(); } catch {}
        };
      } else if (videoRef.current.canPlayType("application/vnd.apple.mpegurl")) {
        videoRef.current.src = hlsUrl;
      }
    }
    // Socket reactions
    try {
      // Always connect via frontend origin; Next.js rewrites proxy to backend
      const wsUrl = window.location.origin.replace(/^http/, "ws");
      const token = typeof window !== "undefined" ? JSON.parse(localStorage.getItem("streamfi-auth") || "{}").state?.session?.token : undefined;
  const socket = io(wsUrl, { transports: ["websocket"], query: { streamId: String(streamId ?? '') }, auth: { token } });
      socketRef.current = socket;
      socket.on("connect", () => setLog((l) => ["[ws] connected", ...l]));
      socket.on("disconnect", () => setLog((l) => ["[ws] disconnected", ...l]));
      socket.on("new_reaction", (evt: { type: string; by: string }) => {
        setLog((l) => [`Reaction: ${evt.type} by ${evt.by.slice(0, 6)}`, ...l]);
        // add burst animation
        const id = Date.now();
        const label = evt.type.toUpperCase();
        setBursts((b) => [...b, { id, label }]);
        setTimeout(() => setBursts((b) => b.filter((x) => x.id !== id)), 1200);
      });
      socket.on("viewer_count", (p: { viewers?: number }) => {
        if (typeof p?.viewers === 'number') setLog((l) => [
          `Viewers: ${p.viewers}`,
          ...l
        ]);
      });
      socket.on("stream_status", (p: { status: string }) => {
        if (p?.status === 'LIVE') {
          // Attempt auto-open when stream goes live
          if (!triedAutoOpenRef.current && address && !channelId && !wrongNetwork) {
            triedAutoOpenRef.current = true;
            openChannelUI();
          }
        } else if (p?.status === 'IDLE') {
          // Auto-close when stream ends
          if (channelId && channelStatus !== 'CLOSED') {
            closeChannel().catch(() => {});
          }
        }
      });
      socket.on("reaction_denied", () => {
        setLog((l) => ["Reaction denied (insufficient balance)", ...l]);
      });
      socket.on("chat_message", (m: { id: string; user: string; text: string; at: number }) => {
        setChat((c) => [...c, m]);
        const id = Math.floor(Math.random() * 1e9);
        setChatFx((fx) => [...fx, { id, text: m.text }]);
        setTimeout(() => setChatFx((fx) => fx.filter((x) => x.id !== id)), 1000);
      });
      socket.on("superchat", (evt: any) => {
        setLog((l) => [
          `Superchat: +${evt.tipAmountEth ?? (Number(evt.tipWei)/1e18).toFixed(6)} ETH (tier ${evt.tier})`,
          ...l
        ]);
        setChannelNonce(evt.nonce);
        setChannelSpentWei(String(evt.cumulativeWei));
        setChat((c) => [...c, { id: `sc-${evt.nonce}`, user: evt.viewerAddress, text: evt.message || '', at: Date.now() }]);
      });
    } catch {}
    return () => {
      socketRef.current?.disconnect();
      if (joined && streamId) users.leaveStream(String(streamId)).catch(() => {});
    };
  }, [streamId, session?.token]);

  useEffect(() => {
    // Load streamer-configured reactions (labels). We ignore fiat prices; tips are in ETH.
    (async () => {
      try {
        if (!streamId) return;
        const items = await api<Array<{ key: string; label?: string; priceInPaise?: number }>>(`/api/reactions/by-stream/${encodeURIComponent(String(streamId))}`);
        const map: Record<string, number> = {};
        for (const it of items) map[it.key] = 1; // presence only; value unused
        if (Object.keys(map).length) setReactionPrices(map);
      } catch {}
    })();
  }, [streamId]);

  useEffect(() => {
    // fetch initial chat history
    (async () => {
      try {
        if (!streamId) return;
        const r = await api<{ items: Array<{ _id: string; userId: string; text: string; createdAt: string }> }>(
          `/api/chat/${encodeURIComponent(String(streamId))}/messages`
        );
        setChat(
          (r.items || []).map((i) => ({ id: i._id, user: i.userId, text: i.text, at: new Date(i.createdAt).getTime() }))
        );
      } catch {}
    })();
  }, [streamId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!streamId) return;
        const init = await channels.init(String(streamId));
        if (cancelled) return;
        if (init?.vaultId) setVaultId(String(init.vaultId));
        if (init?.channelContract) setChannelContract(init.channelContract);
        if (init?.minDepositWei) setMinDepositWei(String(init.minDepositWei));
        if (init?.minTipWei) setMinTipWei(String(init.minTipWei));
        if (init?.chainId) setRequiredChainId(Number(init.chainId));
      } catch (e:any) {
        if (!cancelled) setLog((l)=>[`Overlay channel init failed: ${e?.message || e}`, ...l]);
      }
    })();
    return () => { cancelled = true; };
  }, [streamId]);

  // Check wallet network vs required chain id
  useEffect(() => {
    (async () => {
      try {
        if (!requiredChainId) return;
        const eth = (typeof window !== 'undefined' ? (window as any).ethereum : undefined);
        if (!eth) return;
        const hex = await eth.request({ method: 'eth_chainId' });
        const current = typeof hex === 'string' && hex.startsWith('0x') ? parseInt(hex, 16) : Number(hex);
        setWrongNetwork(current !== requiredChainId);
      } catch {}
    })();
  }, [requiredChainId, address]);

  // Auto-open as soon as wallet is connected and prerequisites are present
  useEffect(() => {
    if (!address || wrongNetwork || channelId || opening) return;
    if (!requiredChainId || !minDepositWei) return;
    if (triedAutoOpenRef.current) return;
    triedAutoOpenRef.current = true;
    openChannelUI();
  }, [address, wrongNetwork, channelId, opening, requiredChainId, minDepositWei]);

  async function onConnect() {
    const acc = await connectWallet();
    setAddress(acc);
  }

  // Reaction -> send a minimal ETH tip using the channel. We use minTipWei by default.
  async function reactOnce(kind: string) {
    try {
      // visual fx
      const id = Date.now();
      setBursts((b) => [...b, { id, label: kind.toUpperCase() }]);
      setTimeout(() => setBursts((b) => b.filter((x) => x.id !== id)), 1000);
      // tip using minTipWei
      const addWei = BigInt(minTipWei || '0');
  if (addWei <= BigInt(0) || !channelId) return;
  await sendTipAmount(addWei, `reaction:${kind}`);
    } catch {}
  }

  async function sendChat() {
    const t = text.trim();
    if (!t) return;
    setText("");
    try {
      const token = typeof window !== "undefined" ? JSON.parse(localStorage.getItem("streamfi-auth") || "{}").state?.session?.token : undefined;
  const csrfRes = await fetch(`${API_BASE}/csrf`, { credentials: "include" });
      const csrfToken = csrfRes.ok ? (await csrfRes.json()).csrfToken as string : undefined;
  const res = await fetch(`${API_BASE}/chat/${encodeURIComponent(String(streamId ?? ''))}/messages`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(csrfToken ? { "x-csrf-token": csrfToken } : {}) },
        body: JSON.stringify({ text: t }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as { item: { _id: string; userId: string; text: string; createdAt: string } };
      setChat((c) => [...c, { id: data.item._id, user: data.item.userId, text: data.item.text, at: new Date(data.item.createdAt).getTime() }]);
  } catch {
      setLog((l) => ["Chat send failed", ...l]);
    }
  }

  async function openChannelUI() {
    if (!address) return;
    try {
      setOpening(true);
      const minDeposit = minDepositWei; // dynamic
      const deposit = minDeposit; // static for MVP
  const resp = await channels.open(String(streamId ?? ''), BigInt(deposit));
      setChannelId(resp.channelId);
      setChannelDepositWei(deposit);
  setChannelStatus('OPEN');
      setLog((l)=>[`Channel opened id=${resp.channelId}`, ...l]);
      // Fetch channel details to populate nonce/spent/vault/status
      try {
        const ch = await channels.get(resp.channelId);
        if (ch?.nonce !== undefined) setChannelNonce(Number(ch.nonce));
        if (ch?.spentWei !== undefined) setChannelSpentWei(String(ch.spentWei || '0'));
        if (ch?.depositWei !== undefined) setChannelDepositWei(String(ch.depositWei));
        if (ch?.streamerVaultId !== undefined) setVaultId(String(ch.streamerVaultId));
        if (ch?.status) setChannelStatus(ch.status);
      } catch {}
    } catch (e:any) {
      setLog((l)=>[`Channel open failed: ${e.message}`, ...l]);
    } finally { setOpening(false); }
  }

  // Low-level tip function using explicit wei amount
  async function sendTipAmount(addWei: bigint, msgOverride?: string) {
    if (!address || !channelId) return;
    try {
      const provider = (window as any).ethereum;
      const newSpent = (BigInt(channelSpentWei) + addWei).toString();
      const nextNonce = channelNonce + 1;
  const domain = { name: 'StreamFiChannel', version: '1', chainId: Number(requiredChainId || 11155111), verifyingContract: channelContract };
      const state = { channelId, vaultId: Number(vaultId), viewer: address, deposit: channelDepositWei, spent: newSpent, nonce: nextNonce } as any;
      const typed = channelTypedData(domain, state);
      const signature = await provider.request({ method: 'eth_signTypedData_v4', params: [address, typed] });
      const resp = await channels.tip({ channelId, newSpentWei: BigInt(newSpent), nonce: nextNonce, signature, message: (msgOverride ?? text) || undefined });
      setChannelSpentWei(newSpent);
      setChannelNonce(resp.nonce);
      setText('');
    } catch (e:any) {
      setLog((l)=>[`Tip failed: ${e.message}`, ...l]);
    }
  }

  async function sendTip() {
    const amt = BigInt(Math.floor(parseFloat(tipEth || '0') * 1e18));
    return sendTipAmount(amt);
  }

  async function closeChannel() {
    if (!channelId) return;
    if (closing || channelStatus === 'CLOSED') return;
    try {
      setClosing(true);
      setChannelStatus('CLOSING');
      const r = await channels.close(channelId);
      setChannelStatus('CLOSED');
      const parts = [`Channel closed deposited=${r.deposited}`];
      if (r.settlementTx) parts.push(`tx=${r.settlementTx}`);
      if (r.skippedOnchain) parts.push('(skipped on-chain)');
      if (r.alreadyClosed) parts.push('(already closed)');
      setLog((l)=>[parts.join(' '), ...l]);
    } catch (e:any) { setLog((l)=>[`Channel close failed: ${e.message}`, ...l]); }
    finally { setClosing(false); }
  }

  // Best-effort channel close on page unload/navigation
  useEffect(() => {
    const handler = () => {
      try { if (channelId && channelStatus !== 'CLOSED') { void channels.close(channelId); } } catch {}
    };
    window.addEventListener('beforeunload', handler);
    return () => { window.removeEventListener('beforeunload', handler); };
  }, [channelId, channelStatus]);

  // Close channel on unmount as well
  useEffect(() => {
    return () => {
      try { if (channelId && channelStatus !== 'CLOSED') { void channels.close(channelId); } } catch {}
    };
  }, [channelId, channelStatus]);

  return (
    <main className="p-4 space-y-4">
      <h1 className="text-xl font-semibold">Stream Overlay</h1>
      <Card>
        <CardContent className="p-3 flex items-center gap-2">
          <strong>Stream:</strong> <code className="ml-2">{String(streamId)}</code>
          <span className="ml-auto flex items-center">
            <strong>Wallet:</strong> <code className="ml-2">{address ?? "Not connected"}</code>
            <Button variant="outline" className="ml-2" onClick={onConnect}>
              {address ? "Reconnect" : "Connect Wallet"}
            </Button>
          </span>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0 relative overflow-hidden">
          <video ref={videoRef} className="w-full aspect-[16/9] rounded-xl" controls playsInline />
          {/* Reaction bursts */}
          <div className="pointer-events-none absolute inset-0 flex items-end justify-center">
            <div className="relative w-full h-0">
              {bursts.map((b) => (
                <span
                  key={b.id}
                  className="absolute left-1/2 -translate-x-1/2 mb-6 select-none text-2xl font-bold animate-bounce text-white drop-shadow-[0_1px_4px_rgba(0,0,0,0.6)]"
                >
                  {b.label}
                </span>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Reactions</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {Object.entries(reactionPrices).map(([k]) => (
                <Button
                  key={k}
                  variant="outline"
                  onClick={() => reactOnce(k)}
                  disabled={loading || !address || !channelId || channelStatus !== 'OPEN'}
                >
                  {k} (+min tip)
                </Button>
              ))}
            </div>
            <div className="text-xs text-muted-foreground mt-2">
              Each reaction sends a minimal ETH tip via your open channel.
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Activity</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="max-h-52 overflow-auto whitespace-pre-wrap">{log.join("\n")}</pre>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Chat</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="max-h-64 overflow-auto space-y-1 mb-2">
              {chat.map((m) => (
                <div key={m.id} className="text-sm">
                  <span className="text-muted-foreground mr-2">{m.user.slice(0, 6)}:</span>
                  <span>{m.text}</span>
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Say something" />
              <Button onClick={sendChat} disabled={!session}>Send</Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Manual channel controls removed: channel auto-opens on LIVE and closes on END; reactions handle micro-tips. */}
    </main>
  );
}
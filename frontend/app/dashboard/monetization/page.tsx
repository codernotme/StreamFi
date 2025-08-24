"use client"
import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { useAuthStore } from "@/stores/auth-store"
import { monetization, type Donation, type NFTSale, type Payout } from "@/modules/monetization"
import { Card } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"

export default function MonetizationPage() {
  const session = useAuthStore((s) => s.session)
  const router = useRouter()
  useEffect(() => {
    if (!session) router.replace("/auth")
  }, [session, router])

  const [loading, setLoading] = useState(true)
  const [donations, setDonations] = useState<Donation[]>([])
  const [nfts, setNfts] = useState<NFTSale[]>([])
  const [payouts, setPayouts] = useState<Payout[]>([])
  const [summary, setSummary] = useState<{ totalDonationsUSD: number; totalNftSales: number; payoutsPendingUSD: number; sparkline: number[] } | null>(null)
  const [range, setRange] = useState<"today" | "7d" | "30d">("7d")
  const [query, setQuery] = useState("")

  useEffect(() => {
    let alive = true
    ;(async () => {
      setLoading(true)
      const [d, n, p, s] = await Promise.all([
        monetization.getDonations(),
        monetization.getNFTSales(),
        monetization.getPayouts(),
        monetization.getSummary(),
      ])
      if (!alive) return
      setDonations(d)
      setNfts(n)
      setPayouts(p)
      setSummary(s)
      setLoading(false)
    })()
    return () => {
      alive = false
    }
  }, [])

  const kpis = useMemo(() => ([
    { label: "Total Donations", value: summary ? `$${summary.totalDonationsUSD.toFixed(2)}` : "—" },
    { label: "NFT Sales", value: summary ? `${summary.totalNftSales.toFixed(2)} ETH` : "—" },
    { label: "Payouts Pending", value: summary ? `$${summary.payoutsPendingUSD.toFixed(2)}` : "—" },
  ]), [summary])

  const fDonations = useMemo(() => {
    const now = Date.now()
    const start = range === "today" ? now - 24 * 60 * 60 * 1000 : range === "7d" ? now - 7 * 24 * 60 * 60 * 1000 : now - 30 * 24 * 60 * 60 * 1000
    const filtered = donations.filter((x) => new Date(x.time).getTime() >= start)
    if (!query) return filtered
    const q = query.toLowerCase()
    return filtered.filter((x) => x.from.toLowerCase().includes(q) || (x.message ?? "").toLowerCase().includes(q) || x.id.toLowerCase().includes(q))
  }, [donations, range, query])
  const fNfts = useMemo(() => {
    const now = Date.now()
    const start = range === "today" ? now - 24 * 60 * 60 * 1000 : range === "7d" ? now - 7 * 24 * 60 * 60 * 1000 : now - 30 * 24 * 60 * 60 * 1000
    const filtered = nfts.filter((x) => new Date(x.time).getTime() >= start)
    if (!query) return filtered
    const q = query.toLowerCase()
    return filtered.filter((x) => x.title.toLowerCase().includes(q) || x.buyer.toLowerCase().includes(q) || x.tokenId.toLowerCase().includes(q) || x.id.toLowerCase().includes(q))
  }, [nfts, range, query])
  const fPayouts = useMemo(() => {
    const now = Date.now()
    const start = range === "today" ? now - 24 * 60 * 60 * 1000 : range === "7d" ? now - 7 * 24 * 60 * 60 * 1000 : now - 30 * 24 * 60 * 60 * 1000
    const filtered = payouts.filter((x) => new Date(x.time).getTime() >= start)
    if (!query) return filtered
    const q = query.toLowerCase()
    return filtered.filter((x) => x.id.toLowerCase().includes(q) || x.status.toLowerCase().includes(q))
  }, [payouts, range, query])

  function exportCSV(rows: Array<Record<string, unknown>>, filename: string) {
    if (!rows || rows.length === 0) return
    const headers = Object.keys(rows[0])
    const esc = (v: unknown) => {
      const s = String(v ?? "")
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
    }
  const getVal = (obj: Record<string, unknown>, key: string) => obj[key]
  const csv = [headers.join(","), ...rows.map((r) => headers.map((h) => esc(getVal(r, h))).join(","))].join("\n")
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return (
    <main className="mx-auto max-w-6xl px-4 sm:px-6 py-8 space-y-6">
      <h1 className="text-2xl font-semibold">Monetization</h1>

      {/* KPIs + Sparkline + Filters + Search */}
      <div className="grid grid-cols-1 gap-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {kpis.map((k) => (
            <Card key={k.label} className="p-4">
              <div className="text-sm text-muted-foreground">{k.label}</div>
              <div className="text-2xl font-semibold mt-1">{k.value}</div>
            </Card>
          ))}
        </div>
        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div className="text-sm text-muted-foreground">Revenue trend</div>
            <div className="flex items-center gap-2">
              <div className="hidden sm:block">
                <Input aria-label="Search" placeholder="Search donations, NFTs, payouts" value={query} onChange={(e)=>setQuery(e.target.value)} />
              </div>
              <div className="inline-flex rounded-md border">
              {(["today","7d","30d"] as const).map((r) => (
                <button
                  key={r}
                  onClick={() => setRange(r)}
                  className={`px-3 py-1 text-sm ${range===r?"bg-primary text-primary-foreground":"hover:bg-muted"}`}
                  type="button"
                >{r.toUpperCase()}</button>
              ))}
              </div>
            </div>
          </div>
          <div className="mt-3">
            {summary && summary.sparkline?.length ? (
              <svg viewBox={`0 0 ${summary.sparkline.length-1} 10`} className="w-full h-12">
                {summary.sparkline.map((v,i)=> i>0 ? (
                  <line key={i} x1={i-1} y1={10-(summary.sparkline[i-1]/Math.max(...summary.sparkline))*10}
                    x2={i} y2={10-(v/Math.max(...summary.sparkline))*10}
                    stroke="currentColor" className="text-primary" strokeWidth="0.2" />
                ): null)}
              </svg>
            ) : (
              <div className="text-sm text-muted-foreground">No data</div>
            )}
          </div>
        </Card>
      </div>

      <Separator />

      {/* Donations */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Donations</h2>
          <Button variant="outline" size="sm" onClick={()=> exportCSV(fDonations.map(d=>({ id: d.id, from: d.from, amount: d.amount, currency: d.currency, time: d.time, message: d.message ?? ""})), "donations.csv")}>Export CSV</Button>
        </div>
        <Card className="overflow-hidden">
          <div className="grid grid-cols-4 gap-2 p-3 text-sm bg-muted/50">
            <div>ID</div><div>From</div><div>Amount</div><div>Time</div>
          </div>
          {loading && <div className="p-4 text-sm text-muted-foreground">Loading…</div>}
          {!loading && fDonations.map(r => (
            <div className="grid grid-cols-4 gap-2 p-3 border-t text-sm" key={r.id}>
              <div>{r.id}</div><div>{r.from}</div><div>${r.amount.toFixed(2)} {r.currency}</div><div>{new Date(r.time).toLocaleString()}</div>
            </div>
          ))}
          {!loading && fDonations.length === 0 && (
            <div className="p-4 text-sm text-muted-foreground">No donations yet.</div>
          )}
        </Card>
      </section>

      {/* NFT Sales */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">NFT Sales</h2>
          <Button variant="outline" size="sm" onClick={()=> exportCSV(fNfts.map(n=>({ id: n.id, tokenId: n.tokenId, title: n.title, buyer: n.buyer, price: n.price, currency: n.currency, txHash: n.txHash, time: n.time })), "nft-sales.csv")}>Export CSV</Button>
        </div>
        <Card className="overflow-hidden">
          <div className="grid grid-cols-6 gap-2 p-3 text-sm bg-muted/50">
            <div>ID</div><div>Token</div><div>Title</div><div>Buyer</div><div>Price</div><div>Time</div>
          </div>
          {loading && <div className="p-4 text-sm text-muted-foreground">Loading…</div>}
          {!loading && fNfts.map(n => (
            <div className="grid grid-cols-6 gap-2 p-3 border-t text-sm" key={n.id}>
              <div>{n.id}</div><div>{n.tokenId}</div><div>{n.title}</div><div>{n.buyer}</div><div>{n.price} {n.currency}</div><div>{new Date(n.time).toLocaleString()}</div>
            </div>
          ))}
          {!loading && fNfts.length === 0 && (
            <div className="p-4 text-sm text-muted-foreground">No NFT sales yet.</div>
          )}
        </Card>
      </section>

      {/* Payouts */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Payouts</h2>
          <Button variant="outline" size="sm" onClick={()=> exportCSV(fPayouts.map(p=>({ id: p.id, amount: p.amount, currency: p.currency, status: p.status, time: p.time })), "payouts.csv")}>Export CSV</Button>
        </div>
        <Card className="overflow-hidden">
          <div className="grid grid-cols-4 gap-2 p-3 text-sm bg-muted/50">
            <div>ID</div><div>Amount</div><div>Status</div><div>Time</div>
          </div>
          {loading && <div className="p-4 text-sm text-muted-foreground">Loading…</div>}
          {!loading && fPayouts.map(p => (
            <div className="grid grid-cols-4 gap-2 p-3 border-t text-sm" key={p.id}>
              <div>{p.id}</div><div>${p.amount.toFixed(2)} {p.currency}</div><div className="capitalize">{p.status}</div><div>{new Date(p.time).toLocaleString()}</div>
            </div>
          ))}
          {!loading && fPayouts.length === 0 && (
            <div className="p-4 text-sm text-muted-foreground">No payouts yet.</div>
          )}
        </Card>
      </section>
    </main>
  )
}

import { store } from "./store.mts";

export type Quote = { price: number | null; asOf: string | null; source: string; error?: string; fetchedAt?: number; stale?: boolean };

const TTL_MS = 5 * 60 * 1000;
// A stored price older than this is not shown as a live price; the deal falls back to its manual value and says why.
export const STALE_MS = 24 * 60 * 60 * 1000;
export const withStaleFlag = (q: Quote, now = Date.now()): Quote => ({ ...q, stale: now - (q.fetchedAt ?? 0) > STALE_MS });
export const validSymbol = (s: string) => /^[A-Z0-9.\-]{1,10}$/.test(s);

async function fetchQuote(symbol: string): Promise<Quote> {
  const key = Netlify.env.get("FINNHUB_API_KEY");
  try {
    if (key) {
      const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${key}`, { signal: AbortSignal.timeout(6000) });
      if (!r.ok) throw new Error(`Finnhub HTTP ${r.status}`);
      const q = (await r.json()) as { c?: number; t?: number };
      if (!q.c) throw new Error("No price returned");
      return { price: q.c, asOf: q.t ? new Date(q.t * 1000).toISOString() : new Date().toISOString(), source: "Finnhub" };
    }
    // Keyless fallback: Stooq daily CSV (US tickers).
    const r = await fetch(`https://stooq.com/q/l/?s=${encodeURIComponent(symbol.toLowerCase())}.us&f=sd2t2c&h&e=csv`, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error(`Stooq HTTP ${r.status}`);
    const row = (await r.text()).trim().split(/\r?\n/)[1]?.split(",") ?? [];
    const close = parseFloat(row[3]);
    if (!Number.isFinite(close)) throw new Error("No price returned");
    return { price: close, asOf: `${row[1]}T${row[2]}Z`, source: "Stooq" };
  } catch (e) {
    return { price: null, asOf: null, source: key ? "Finnhub" : "Stooq", error: (e as Error).message };
  }
}

// Cached for 5 minutes so page loads don't hammer the provider.
export async function getQuotes(symbols: string[]): Promise<Record<string, Quote>> {
  const s = store();
  const out: Record<string, Quote> = {};
  await Promise.all(
    [...new Set(symbols.filter(validSymbol))].map(async (sym) => {
      const cached = (await s.get(`cache/price/${sym}`, { type: "json" })) as (Quote & { fetchedAt: number }) | null;
      if (cached && Date.now() - cached.fetchedAt < TTL_MS) {
        out[sym] = { ...cached, stale: false };
        return;
      }
      const q = await fetchQuote(sym);
      if (q.price !== null) await s.setJSON(`cache/price/${sym}`, { ...q, fetchedAt: Date.now() });
      // If the refresh failed, keep the last good price but flag it stale so it is never presented as live.
      out[sym] = q.price === null && cached ? { ...cached, stale: true, error: q.error } : q;
    }),
  );
  return out;
}

// Cached quotes only (never calls the provider), so loading the dashboard stays fast.
export async function cachedQuotes(symbols: string[]): Promise<Record<string, Quote>> {
  const s = store();
  const out: Record<string, Quote> = {};
  await Promise.all(
    [...new Set(symbols.filter(validSymbol))].map(async (sym) => {
      const c = (await s.get(`cache/price/${sym}`, { type: "json" })) as Quote | null;
      if (c) out[sym] = withStaleFlag(c);
    }),
  );
  return out;
}

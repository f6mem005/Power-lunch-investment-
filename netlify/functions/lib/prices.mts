import { store } from "./store.mts";

export type Quote = { price: number | null; asOf: string | null; source: string; error?: string; fetchedAt?: number; stale?: boolean; failedAt?: number; lastError?: string };

const TTL_MS = 5 * 60 * 1000;
const RETRY_MS = 60 * 1000; // after a failed lookup, wait this long before asking the provider again
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
// What callers get: only the public fields, never the bookkeeping kept in the cache entry.
const publicQuote = (q: Quote, stale: boolean, error?: string): Quote => ({ price: q.price, asOf: q.asOf, source: q.source, stale, ...(error ? { error } : {}) });

export async function getQuotes(symbols: string[]): Promise<Record<string, Quote>> {
  const s = store();
  const out: Record<string, Quote> = {};
  await Promise.all(
    [...new Set(symbols.filter(validSymbol))].map(async (sym) => {
      const key = `cache/price/${sym}`;
      const cached = (await s.get(key, { type: "json" })) as (Quote & { fetchedAt?: number }) | null;
      if (cached && cached.price !== null && Date.now() - (cached.fetchedAt ?? 0) < TTL_MS) {
        out[sym] = publicQuote(cached, false);
        return;
      }
      // The provider failed a moment ago: don't make every page load wait on it again.
      if (cached && cached.failedAt && Date.now() - cached.failedAt < RETRY_MS) {
        out[sym] = publicQuote(cached, withStaleFlag(cached).stale === true, cached.lastError);
        return;
      }
      const q = await fetchQuote(sym);
      if (q.price !== null) {
        await s.setJSON(key, { ...q, fetchedAt: Date.now() });
        out[sym] = publicQuote(q, false);
        return;
      }
      // Failed. If another request stored a newer good price while we waited on the provider, use that instead of overwriting it.
      try {
        const latest = (await s.get(key, { type: "json" })) as (Quote & { fetchedAt?: number }) | null;
        if (latest && latest.price !== null && (latest.fetchedAt ?? 0) > (cached?.fetchedAt ?? 0)) { out[sym] = publicQuote(latest, false); return; }
      } catch { /* fall through */ }
      // Remember the failure (also for a ticker that has never had a price), but never let a cache write break the request.
      try { await s.setJSON(key, { price: cached?.price ?? null, asOf: cached?.asOf ?? null, source: cached?.source ?? q.source, fetchedAt: cached?.fetchedAt ?? 0, failedAt: Date.now(), lastError: q.error }); } catch { /* ignore */ }
      out[sym] = cached && cached.price !== null ? publicQuote(cached, withStaleFlag(cached).stale === true, q.error) : q;
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
      const c = (await s.get(`cache/price/${sym}`, { type: "json" })) as (Quote & { fetchedAt?: number }) | null;
      if (c && c.price !== null) out[sym] = publicQuote(c, withStaleFlag(c).stale === true, c.failedAt ? c.lastError : undefined);
    }),
  );
  return out;
}

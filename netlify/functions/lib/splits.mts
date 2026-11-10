// Automatic stock-split handling.
//
// A deal's share count is valid "as of" a date (sharesAsOf). Any split dated AFTER that date is applied once:
// the count is multiplied by the split ratio and the change is logged on the deal. Cost (dollars invested) is never
// touched: a split changes how many shares there are, not what was paid.
import { finnhubBase, validSymbol } from "./prices.mts";
import { todayStr } from "./dates.mts";
import { KINDS, getOne, listAll, putOne, store } from "./store.mts";
import type { Deal, SplitEntry } from "./store.mts";

export type SplitStatus = {
  checkedAt: string;
  ok: boolean;
  message: string;
  applied: { deal: string; ticker: string; date: string; from: number; to: number; before: number; after: number }[];
};
export type ProviderSplit = { date: string; from: number; to: number };

const isDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
export const splitKey = (s: { date: string; from: number; to: number }) => `${s.date}|${s.from}|${s.to}`;
export const ratioOk = (s: ProviderSplit) => {
  const r = s.to / s.from;
  return Number.isFinite(r) && r !== 1 && r >= 1e-4 && r <= 1e3; // anything outside this is bad data, not a split
};

// Multiply the deal's share count by the split ratio and log it. Returns the log entry, or null if there is nothing to split.
export function applySplit(deal: Deal, s: ProviderSplit, source: string): SplitEntry | null {
  const before = deal.sharesHeld;
  if (!before) return null;
  const after = round6(before * (s.to / s.from));
  if (!(after > 0)) return null;
  const entry: SplitEntry = { date: s.date, from: s.from, to: s.to, before, after, appliedAt: new Date().toISOString(), source };
  deal.sharesHeld = after;
  deal.splitLog = [...(deal.splitLog ?? []), entry].slice(-20);
  return entry;
}

export async function fetchSplits(symbol: string, from: string, to: string): Promise<{ splits?: ProviderSplit[]; error?: string }> {
  const key = Netlify.env.get("FINNHUB_API_KEY");
  if (!key) return { error: "no Finnhub API key" };
  try {
    const r = await fetch(`${finnhubBase()}/stock/split?symbol=${encodeURIComponent(symbol)}&from=${from}&to=${to}&token=${key}`, { signal: AbortSignal.timeout(8000) });
    if (r.status === 401 || r.status === 403) return { error: `Finnhub did not allow the stock-split lookup for this key (HTTP ${r.status}); split data may need a paid Finnhub plan` };
    if (!r.ok) return { error: `Finnhub HTTP ${r.status}` };
    const body = (await r.json()) as unknown;
    if (!Array.isArray(body)) return { error: "Finnhub returned something unexpected for stock splits" };
    const splits = body
      .map((x: any) => ({ date: x?.date, from: Number(x?.fromFactor), to: Number(x?.toFactor) }))
      .filter((x): x is ProviderSplit => isDate(x.date) && Number.isFinite(x.from) && Number.isFinite(x.to) && x.from > 0 && x.to > 0);
    return { splits };
  } catch (e) {
    return { error: `could not reach Finnhub (${(e as Error).message})` };
  }
}

// Which of the provider's splits still have to be applied to this deal? Never a split on or before the date the share count
// is valid from, never one in the future, never one already logged, and always in date order.
export function splitsToApply(deal: Deal, splits: ProviderSplit[], today: string): ProviderSplit[] {
  if (!deal.sharesAsOf) return [];
  const done = new Set((deal.splitLog ?? []).map(splitKey));
  return splits
    .filter((s) => s.date > deal.sharesAsOf! && s.date <= today && ratioOk(s) && !done.has(splitKey(s)))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export async function checkSplits(): Promise<SplitStatus> {
  const today = todayStr();
  const status: SplitStatus = { checkedAt: new Date().toISOString(), ok: true, message: "", applied: [] };
  const finish = async (ok: boolean, message: string) => {
    status.ok = ok;
    status.message = message;
    try { await store().setJSON("meta/splits-status", status); } catch { /* the status is only informational */ }
    return status;
  };
  if (!Netlify.env.get("FINNHUB_API_KEY")) return finish(false, "Automatic split checks need a Finnhub API key (FINNHUB_API_KEY) in Netlify's environment variables.");

  const tracked = (await listAll<Deal>(KINDS.deal)).filter((d) => d.ticker && validSymbol(d.ticker) && d.sharesHeld);
  if (!tracked.length) return finish(true, "No public deals have a share count yet, so there is nothing to check.");

  // First time a share count is seen it is taken as valid from today: it is never adjusted for the past.
  for (const d of tracked) {
    if (d.sharesAsOf) continue;
    const fresh = await getOne<Deal>(KINDS.deal, d.id); // write to the latest copy so a concurrent admin edit isn't overwritten
    if (fresh && fresh.sharesHeld && !fresh.sharesAsOf) { fresh.sharesAsOf = today; await putOne(KINDS.deal, fresh); }
    d.sharesAsOf = fresh?.sharesAsOf ?? today;
  }

  const byTicker = new Map<string, Deal[]>();
  for (const d of tracked) byTicker.set(d.ticker!, [...(byTicker.get(d.ticker!) ?? []), d]);
  const problems: string[] = [];
  await Promise.all(
    [...byTicker.entries()].map(async ([ticker, deals]) => {
      const from = deals.map((d) => d.sharesAsOf!).sort()[0];
      const r = await fetchSplits(ticker, from, today);
      if (r.error || !r.splits) { problems.push(`${ticker}: ${r.error}`); return; }
      for (const d of deals) {
        const fresh = await getOne<Deal>(KINDS.deal, d.id); // the latest copy, in case the admin just edited it
        if (!fresh || !fresh.sharesHeld) continue;
        const todo = splitsToApply(fresh, r.splits, today);
        if (!todo.length) continue;
        for (const s of todo) {
          const e = applySplit(fresh, s, "Finnhub");
          if (e) status.applied.push({ deal: fresh.name, ticker, date: e.date, from: e.from, to: e.to, before: e.before, after: e.after });
        }
        await putOne(KINDS.deal, fresh);
      }
    }),
  );

  if (status.applied.length) {
    const n = status.applied.length;
    return finish(problems.length === 0, `Adjusted ${n} share count${n === 1 ? "" : "s"} for a stock split.${problems.length ? ` Could not check: ${problems.join("; ")}.` : ""}`);
  }
  if (problems.length) return finish(false, `Could not check for splits: ${problems.join("; ")}.`);
  return finish(true, `Checked ${byTicker.size} ticker${byTicker.size === 1 ? "" : "s"}: no new splits.`);
}

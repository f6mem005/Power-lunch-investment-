// Stock splits are recorded by hand (Deals tab > Edit deal > Record a stock split). A split multiplies the deal's share count and is logged on the deal.
// Dollars invested and the manual value are never touched: a split changes how many shares there are, not what was paid.
import type { Deal, SplitEntry } from "./store.mts";

export type Split = { date: string; from: number; to: number };

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
export const splitKey = (s: Split) => `${s.date}|${s.from}|${s.to}`;
export const ratioOk = (s: Split) => {
  const r = s.to / s.from;
  return Number.isFinite(r) && r !== 1 && r >= 1e-4 && r <= 1e3; // anything outside this is a typo, not a split
};

// Multiply the deal's share count by the split ratio and log it. Returns the log entry, or null if there is nothing to split.
export function applySplit(deal: Deal, s: Split, source: string): SplitEntry | null {
  const before = deal.sharesHeld;
  if (!before) return null;
  const after = round6(before * (s.to / s.from));
  if (!(after > 0)) return null;
  const entry: SplitEntry = { date: s.date, from: s.from, to: s.to, before, after, appliedAt: new Date().toISOString(), source };
  deal.sharesHeld = after;
  deal.splitLog = [...(deal.splitLog ?? []), entry].slice(-20);
  return entry;
}

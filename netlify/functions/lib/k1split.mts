// How a deal's K-1 is shared out across the people who hold the deal. The browser does the same sum for the admin's screens;
// the server does it here so a holder of an individual deal can be sent their own share and nothing else (not the K-1's lines,
// total or note, and not what the other holders got).
import type { Holding, K1Record } from "./store.mts";

const cents = (n: number) => Math.round(n * 100);

// Shares a whole number of cents across weights so the pieces add up exactly (largest remainder; works for losses too).
export function splitCents(total: number, weights: number[]): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (!(sum > 0)) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum), base = raw.map((v) => Math.trunc(v));
  const rest = total - base.reduce((s, v) => s + v, 0);
  const order = raw.map((v, i) => ({ i, frac: Math.abs(v - base[i]) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < Math.abs(rest); k++) base[order[k % order.length].i] += rest > 0 ? 1 : -1;
  return base;
}

// Each holder's share of one K-1: split by the money each person had in the deal at 12/31 of the K-1's year. Returns null when
// nobody had invested by then (the K-1 can't be split). Amounts are dollars.
export function k1Split(rec: K1Record, dealHoldings: Holding[]): Map<string, { income: number; expenses: number }> | null {
  const held = dealHoldings.filter((h) => h.dealId === rec.dealId && h.date <= `${rec.year}-12-31`);
  const byPerson = new Map<string, number>();
  for (const h of held) byPerson.set(h.personId, (byPerson.get(h.personId) || 0) + h.invested);
  const ids = [...byPerson.keys()].sort(), weights = ids.map((id) => byPerson.get(id)!);
  if (!(weights.reduce((s, w) => s + w, 0) > 0)) return null;
  const sumOf = (type: string) => cents(rec.lines.filter((l) => l.type === type).reduce((s, l) => s + l.amount, 0));
  const inc = splitCents(sumOf("income"), weights), exp = splitCents(sumOf("expense"), weights);
  return new Map(ids.map((id, i) => [id, { income: inc[i] / 100, expenses: exp[i] / 100 }]));
}

// Builds exactly what one signed-in person is allowed to see. All privacy rules live here, on the server:
//   admin           -> everything
//   any deal        -> every holder of any deal (club or individual) you hold a stake in: you see who invested
//                      alongside you
//   club member     -> additionally, every holding in every Power Lunch Club deal
// Deals you hold no stake in, and are not a club member for, are invisible. The `partial` branch below (own stake
// only, nothing revealing others' amounts) can no longer be reached by this rule; it is kept as a safety net so a
// future, stricter rule cannot leak by accident.
import type { Quote } from "./prices.mts";
import type { Deal, Holding, Person } from "./store.mts";

export type Viewer = { kind: "admin" } | { kind: "person"; person: Person };

export function buildView(viewer: Viewer, people: Person[], deals: Deal[], holdings: Holding[], quotes: Record<string, Quote>) {
  const isAdmin = viewer.kind === "admin";
  const me = viewer.kind === "person" ? viewer.person : null;
  const dealById = new Map(deals.map((d) => [d.id, d]));

  const invested: Record<string, number> = {};
  holdings.forEach((h) => (invested[h.dealId] = (invested[h.dealId] || 0) + h.invested));

  const valuation = (d: Deal) => {
    const q = d.ticker ? quotes[d.ticker] : undefined;
    if (d.ticker && d.sharesHeld && q?.price) return { value: d.sharesHeld * q.price, basis: "live", price: q.price };
    if (d.manualValue != null) return { value: d.manualValue, basis: d.valueSource, price: q?.price ?? null };
    return { value: invested[d.id] || 0, basis: "cost", price: q?.price ?? null };
  };
  const holders = new Map<string, Set<string>>();
  holdings.forEach((h) => holders.set(h.dealId, (holders.get(h.dealId) ?? new Set<string>()).add(h.personId)));
  const seesWholeDeal = (d: Deal) =>
    isAdmin || (d.channel === "club" && me?.type === "member") || (!!me && !!holders.get(d.id)?.has(me.id));

  const rows = holdings.flatMap((h) => {
    const d = dealById.get(h.dealId);
    if (!d) return [];
    if (!seesWholeDeal(d) && h.personId !== me?.id) return []; // not theirs, not a club deal they belong to
    const total = invested[d.id] || 0;
    const share = total ? h.invested / total : 0;
    const gross = valuation(d).value * share;
    const fee = h.invested * ((d.mgmtFeePct || 0) / 100);
    const carry = ((d.carryPct || 0) / 100) * Math.max(0, gross + h.distributions - h.invested); // % of profit, no hurdle
    return [{ id: h.id, dealId: h.dealId, personId: h.personId, date: h.date, invested: h.invested, distributions: h.distributions, gross, fee, carry, value: gross - carry, share: seesWholeDeal(d) ? share : null, shares: seesWholeDeal(d) && d.sharesHeld ? d.sharesHeld * share : null }];
  });

  const dealIds = new Set(rows.map((r) => r.dealId));
  const visibleDeals = deals
    .filter((d) => isAdmin || dealIds.has(d.id))
    .map((d) => {
      const v = valuation(d);
      const q = d.ticker ? quotes[d.ticker] : undefined;
      const whole = seesWholeDeal(d);
      const base = {
        id: d.id, name: d.name, channel: d.channel, ticker: d.ticker, mgmtFeePct: d.mgmtFeePct ?? null, carryPct: d.carryPct ?? null,
        basis: v.basis, price: v.price, priceError: q?.error ?? null, needsShares: !!(d.ticker && !d.sharesHeld), partial: !whole,
        valueAsOf: v.basis === "live" ? null : d.valueAsOf,
      };
      if (isAdmin) return { ...d, ...base };
      return whole ? { ...base, sharesHeld: d.sharesHeld, notes: d.notes } : base;
    });

  const peopleIds = new Set(rows.map((r) => r.personId));
  if (me) {
    peopleIds.add(me.id);
    if (me.type === "member") people.filter((p) => p.type === "member").forEach((p) => peopleIds.add(p.id));
  }
  const visiblePeople = people
    .filter((p) => isAdmin || peopleIds.has(p.id))
    .map((p) => ({ id: p.id, name: p.name, type: p.type, order: p.order }))
    .sort((a, b) => a.order - b.order);

  const tickers = new Set(visibleDeals.map((d) => d.ticker).filter(Boolean) as string[]);
  const visibleQuotes: Record<string, Quote> = {};
  tickers.forEach((t) => quotes[t] && (visibleQuotes[t] = quotes[t]));

  return {
    role: isAdmin ? "admin" : "person",
    me: me ? { id: me.id, name: me.name, type: me.type } : null,
    people: visiblePeople,
    deals: visibleDeals,
    holdings: rows,
    quotes: visibleQuotes,
  };
}

// Builds exactly what one signed-in person is allowed to see. All privacy rules live here, on the server:
//   admin           -> everything
//   any deal        -> every holder of any deal (club or individual) you hold a stake in: you see who invested
//                      alongside you
//   club member     -> additionally, every holding in every Power Lunch Club deal
// A deal a person added for themselves (ownerId set) is visible only to that person and the admin, whatever else is true.
// Deals you hold no stake in, and are not a club member for, are invisible. The `partial` branch below (own stake
// only, nothing revealing others' amounts) can no longer be reached by this rule; it is kept as a safety net so a
// future, stricter rule cannot leak by accident.
import type { Quote } from "./prices.mts";
import type { AccountValue, Deal, Holding, K1Record, Person } from "./store.mts";

export type Viewer = { kind: "admin" } | { kind: "person"; person: Person };

export function buildView(viewer: Viewer, people: Person[], allDeals: Deal[], allHoldings: Holding[], quotes: Record<string, Quote>, allK1: K1Record[] = [], allAcct: AccountValue[] = []) {
  const isAdmin = viewer.kind === "admin";
  const me = viewer.kind === "person" ? viewer.person : null;

  // A deal a person added for themselves ("My deals", marked by ownerId) is private to that person and the admin. It never enters
  // the shared computations below, so nothing about it can reach anyone else's lists, people, totals or quotes. It is returned
  // separately, as `ownDeals` / `ownHoldings`, and only to its owner (and the admin).
  const deals = allDeals.filter((d) => !d.ownerId);
  const sharedIds = new Set(deals.map((d) => d.id));
  const holdings = allHoldings.filter((h) => sharedIds.has(h.dealId));
  const dealById = new Map(deals.map((d) => [d.id, d]));

  const invested: Record<string, number> = {};
  allHoldings.forEach((h) => (invested[h.dealId] = (invested[h.dealId] || 0) + h.invested));

  const valuation = (d: Deal) => {
    const q = d.ticker ? quotes[d.ticker] : undefined;
    const price = q?.price && !q.stale ? q.price : null; // a stale price is never used as a live price
    if (d.ticker && d.sharesHeld && price) return { value: d.sharesHeld * price, basis: "live", price };
    if (d.manualValue != null) return { value: d.manualValue, basis: d.valueSource, price };
    return { value: invested[d.id] || 0, basis: "cost", price };
  };
  const holders = new Map<string, Set<string>>();
  holdings.forEach((h) => holders.set(h.dealId, (holders.get(h.dealId) ?? new Set<string>()).add(h.personId)));
  const seesWholeDeal = (d: Deal) =>
    isAdmin || (d.channel === "club" && me?.type === "member") || (!!me && !!holders.get(d.id)?.has(me.id));

  const rowOf = (h: Holding, d: Deal, whole: boolean) => {
    const total = invested[d.id] || 0;
    const share = total ? h.invested / total : 0;
    const gross = valuation(d).value * share;
    const fee = h.invested * ((d.mgmtFeePct || 0) / 100);
    const carry = ((d.carryPct || 0) / 100) * Math.max(0, gross + h.distributions - h.invested); // % of profit, no hurdle
    return { id: h.id, dealId: h.dealId, personId: h.personId, date: h.date, invested: h.invested, distributions: h.distributions, distLog: h.distLog ?? [], gross, fee, carry, value: gross - carry, share: whole ? share : null, shares: whole && d.sharesHeld ? d.sharesHeld * share : null };
  };
  const baseOf = (d: Deal, whole: boolean) => {
    const v = valuation(d);
    const q = d.ticker ? quotes[d.ticker] : undefined;
    return {
      id: d.id, name: d.name, channel: d.channel, ticker: d.ticker, mgmtFeePct: d.mgmtFeePct ?? null, carryPct: d.carryPct ?? null,
      basis: v.basis, price: v.price, priceError: q?.error ?? (q?.stale ? "the last live price is over a day old" : null), needsShares: !!(d.ticker && !d.sharesHeld), partial: !whole,
      valueAsOf: v.basis === "live" ? null : d.valueAsOf,
    };
  };

  const rows = holdings.flatMap((h) => {
    const d = dealById.get(h.dealId);
    if (!d) return [];
    if (!seesWholeDeal(d) && h.personId !== me?.id) return []; // not theirs, not a club deal they belong to
    return [rowOf(h, d, seesWholeDeal(d))];
  });

  const dealIds = new Set(rows.map((r) => r.dealId));
  const visibleDeals = deals
    .filter((d) => isAdmin || dealIds.has(d.id))
    .map((d) => {
      const whole = seesWholeDeal(d);
      const base = baseOf(d, whole);
      if (isAdmin) return { ...d, ...base, valueAsOf: d.valueAsOf }; // admin edits the stored date, not the display one
      return whole ? { ...base, sharesHeld: d.sharesHeld, notes: d.notes } : base;
    });

  // "My deals": the person's own, or (admin) everyone's. The owner sees and edits all of their own deal's fields.
  const ownDeals = allDeals
    .filter((d) => d.ownerId && (isAdmin || d.ownerId === me?.id))
    .map((d) => ({ ...d, ...baseOf(d, true), valueAsOf: d.valueAsOf }));
  const ownIds = new Set(ownDeals.map((d) => d.id));
  const allDealById = new Map(allDeals.map((d) => [d.id, d]));
  const ownHoldings = allHoldings.filter((h) => ownIds.has(h.dealId)).map((h) => rowOf(h, allDealById.get(h.dealId)!, true));

  // The club's K-1s and deal account values are club records: the admin and club members get them, for Power Lunch Club deals
  // only (never a private deal), and nobody else does, whatever stake they hold.
  const seesClubRecords = isAdmin || me?.type === "member";
  const clubDealIds = new Set(deals.filter((d) => d.channel === "club").map((d) => d.id));
  const k1 = seesClubRecords ? allK1.filter((r) => clubDealIds.has(r.dealId)) : [];
  const accountValues = seesClubRecords ? allAcct.filter((r) => clubDealIds.has(r.dealId)) : [];

  const peopleIds = new Set(rows.map((r) => r.personId));
  if (me) {
    peopleIds.add(me.id);
    if (me.type === "member") people.filter((p) => p.type === "member").forEach((p) => peopleIds.add(p.id));
  }
  const visiblePeople = people
    .filter((p) => isAdmin || peopleIds.has(p.id))
    .map((p) => ({ id: p.id, name: p.name, type: p.type, order: p.order }))
    .sort((a, b) => a.order - b.order);

  const tickers = new Set([...visibleDeals, ...ownDeals].map((d) => d.ticker).filter(Boolean) as string[]);
  const visibleQuotes: Record<string, Quote> = {};
  tickers.forEach((t) => quotes[t] && (visibleQuotes[t] = quotes[t]));

  return {
    role: isAdmin ? "admin" : "person",
    me: me ? { id: me.id, name: me.name, type: me.type } : null,
    people: visiblePeople,
    deals: visibleDeals,
    holdings: rows,
    ownDeals,
    ownHoldings,
    k1,
    accountValues,
    quotes: visibleQuotes,
  };
}

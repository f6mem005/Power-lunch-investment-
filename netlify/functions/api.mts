import type { Config } from "@netlify/functions";
import { clearCookie, getRole } from "./lib/auth.mts";
import { getQuotes, validSymbol } from "./lib/prices.mts";
import { KINDS, deleteOne, ensureSeeded, getOne, listAll, putOne } from "./lib/store.mts";
import type { Deal, Holding, Person } from "./lib/store.mts";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
const fail = (error: string, status = 400) => json({ error }, status);

class BadInput extends Error {}
const bad = (m: string): never => {
  throw new BadInput(m);
};

const str = (v: unknown, name: string, max = 120) => {
  const s = String(v ?? "").trim();
  if (!s) bad(`${name} is required`);
  if (s.length > max) bad(`${name} is too long`);
  return s;
};
const optStr = (v: unknown, max = 500) => String(v ?? "").trim().slice(0, max);
const money = (v: unknown, name: string) => {
  const n = Number(v);
  if (v === "" || v === null || v === undefined || !Number.isFinite(n) || n < 0 || n > 1e12) bad(`${name} must be a number of 0 or more`);
  return Math.round(n * 100) / 100;
};
const optMoney = (v: unknown, name: string) => (v === "" || v === null || v === undefined ? null : money(v, name));
const optPct = (v: unknown, name: string) => {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) bad(`${name} must be between 0 and 100`);
  return Math.round(n * 1000) / 1000;
};
const dateStr = (v: unknown, name: string) => {
  const s = str(v, name, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) bad(`${name} must be a date (YYYY-MM-DD)`);
  return s;
};
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "item";
const newId = (label: string) => `${slug(label)}-${crypto.randomUUID().slice(0, 6)}`;
const ticker = (v: unknown) => {
  const s = optStr(v, 10).toUpperCase();
  if (!s) return null;
  if (!validSymbol(s)) bad("Ticker must be letters/numbers (e.g. SPCX)");
  return s;
};

export default async (req: Request) => {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const [resource, id] = parts;
  const method = req.method;
  const role = await getRole(req);

  if (resource === "session" && method === "GET") return json({ role });
  if (resource === "logout" && method === "POST") return json({ ok: true }, 200, { "set-cookie": clearCookie() });
  if (!role) return fail("Please sign in", 401);

  try {
    if (resource === "data" && method === "GET") {
      await ensureSeeded();
      const [people, deals, holdings] = await Promise.all([
        listAll<Person>(KINDS.person),
        listAll<Deal>(KINDS.deal),
        listAll<Holding>(KINDS.holding),
      ]);
      people.sort((a, b) => a.order - b.order);
      return json({ role, people, deals, holdings });
    }

    if (resource === "prices" && method === "GET") {
      const deals = await listAll<Deal>(KINDS.deal);
      return json(await getQuotes(deals.map((d) => d.ticker).filter(Boolean) as string[]));
    }

    // Everything below changes data and needs the admin passcode.
    if (role !== "admin") return fail("Admin access required", 403);
    if (method !== "GET" && !(req.headers.get("content-type") || "").includes("application/json")) return fail("Expected JSON", 415);
    const body = method === "POST" || method === "PUT" ? await req.json().catch(() => bad("Invalid JSON")) : {};

    if (resource === "people") {
      if (method === "POST") {
        const existing = await listAll<Person>(KINDS.person);
        const name = str(body.name, "Name", 60);
        if (existing.some((p) => p.name.toLowerCase() === name.toLowerCase())) bad("That person already exists");
        const person: Person = {
          id: newId(name),
          name,
          type: body.type === "member" ? "member" : "non-member",
          order: Math.max(0, ...existing.map((p) => p.order)) + 1,
        };
        await putOne(KINDS.person, person);
        return json(person, 201);
      }
      if (method === "PUT" && id) {
        const p = await getOne<Person>(KINDS.person, id);
        if (!p) return fail("Not found", 404);
        p.name = str(body.name ?? p.name, "Name", 60);
        p.type = body.type === "member" ? "member" : "non-member";
        await putOne(KINDS.person, p);
        return json(p);
      }
    }

    if (resource === "deals") {
      if (method === "POST") {
        const name = str(body.name, "Name");
        const deal: Deal = {
          id: newId(name),
          name,
          channel: body.channel === "individual" ? "individual" : "club",
          ticker: ticker(body.ticker),
          sharesHeld: optMoney(body.sharesHeld, "Shares held"),
          manualValue: optMoney(body.manualValue, "Current value"),
          valueSource: body.manualValue === "" || body.manualValue == null ? "estimate" : "statement",
          valueAsOf: body.manualValue === "" || body.manualValue == null ? null : new Date().toISOString().slice(0, 10),
          spvTotalRaise: optMoney(body.spvTotalRaise, "SPV total raise"),
          mgmtFeePct: optPct(body.mgmtFeePct, "Management fee"),
          carryPct: optPct(body.carryPct, "Carry"),
          notes: optStr(body.notes),
          valueHistory: [],
        };
        await putOne(KINDS.deal, deal);
        return json(deal, 201);
      }
      if (method === "PUT" && id) {
        const d = await getOne<Deal>(KINDS.deal, id);
        if (!d) return fail("Not found", 404);
        d.name = str(body.name ?? d.name, "Name");
        d.channel = body.channel === "individual" ? "individual" : "club";
        d.ticker = ticker(body.ticker);
        d.sharesHeld = optMoney(body.sharesHeld, "Shares held");
        d.spvTotalRaise = optMoney(body.spvTotalRaise, "SPV total raise");
        d.mgmtFeePct = optPct(body.mgmtFeePct, "Management fee");
        d.carryPct = optPct(body.carryPct, "Carry");
        d.notes = optStr(body.notes);
        const nextValue = optMoney(body.manualValue, "Current value");
        const nextSource = ["statement", "estimate"].includes(body.valueSource) ? body.valueSource : "estimate";
        if (nextValue !== d.manualValue || nextSource !== d.valueSource) {
          d.valueHistory = [...(d.valueHistory ?? []), { at: new Date().toISOString(), value: d.manualValue, source: d.valueSource, note: optStr(body.valueNote, 200) }].slice(-50);
          d.manualValue = nextValue;
          d.valueSource = nextSource;
          d.valueAsOf = body.valueAsOf ? dateStr(body.valueAsOf, "Value as-of date") : new Date().toISOString().slice(0, 10);
        } else if (body.valueAsOf) {
          d.valueAsOf = dateStr(body.valueAsOf, "Value as-of date");
        }
        await putOne(KINDS.deal, d);
        return json(d);
      }
      if (method === "DELETE" && id) {
        const holdings = await listAll<Holding>(KINDS.holding);
        if (holdings.some((h) => h.dealId === id)) return fail("Remove this deal's holdings first", 409);
        await deleteOne(KINDS.deal, id);
        return json({ ok: true });
      }
    }

    if (resource === "holdings") {
      const checkRefs = async (dealId: string, personId: string) => {
        if (!(await getOne(KINDS.deal, dealId))) bad("Unknown deal");
        if (!(await getOne(KINDS.person, personId))) bad("Unknown person");
      };
      if (method === "POST") {
        const h: Holding = {
          id: crypto.randomUUID().slice(0, 8),
          dealId: str(body.dealId, "Deal"),
          personId: str(body.personId, "Person"),
          date: dateStr(body.date, "Investment date"),
          invested: money(body.invested, "Amount invested"),
          distributions: body.distributions === "" || body.distributions == null ? 0 : money(body.distributions, "Distributions"),
        };
        await checkRefs(h.dealId, h.personId);
        await putOne(KINDS.holding, h);
        return json(h, 201);
      }
      if (method === "PUT" && id) {
        const h = await getOne<Holding>(KINDS.holding, id);
        if (!h) return fail("Not found", 404);
        h.dealId = str(body.dealId ?? h.dealId, "Deal");
        h.personId = str(body.personId ?? h.personId, "Person");
        h.date = dateStr(body.date ?? h.date, "Investment date");
        h.invested = money(body.invested ?? h.invested, "Amount invested");
        h.distributions = body.distributions === "" || body.distributions == null ? 0 : money(body.distributions, "Distributions");
        await checkRefs(h.dealId, h.personId);
        await putOne(KINDS.holding, h);
        return json(h);
      }
      if (method === "DELETE" && id) {
        await deleteOne(KINDS.holding, id);
        return json({ ok: true });
      }
    }

    return fail("Not found", 404);
  } catch (e) {
    if (e instanceof BadInput) return fail(e.message);
    console.error(e);
    return fail("Something went wrong", 500);
  }
};

export const config: Config = { path: "/api/*" };

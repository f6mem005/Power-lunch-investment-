import type { Config } from "@netlify/functions";
import { clearCookie, hashPasscode, readSession } from "./lib/auth.mts";
import type { Session } from "./lib/auth.mts";
import { todayStr as today } from "./lib/dates.mts";
import { cachedQuotes, getQuotes, validSymbol } from "./lib/prices.mts";
import { checkSplits } from "./lib/splits.mts";
import type { SplitStatus } from "./lib/splits.mts";
import { KINDS, deleteAuth, deleteOne, ensureSeeded, getAuth, getOne, listAll, putAuth, putOne, store } from "./lib/store.mts";
import type { AuthRecord, Deal, Holding, Person } from "./lib/store.mts";
import { buildView } from "./lib/view.mts";
import type { Viewer } from "./lib/view.mts";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
const fail = (error: string, status = 400) => json({ error }, status);

class BadInput extends Error {}
function bad(m: string): never {
  throw new BadInput(m);
}

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
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  // Round-trip through a real date so impossible days (2026-02-31, which Date.parse accepts) are rejected.
  const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
  if (!m || !d || d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) bad(`${name} must be a real date (YYYY-MM-DD)`);
  return s;
};
// Share counts keep up to 6 decimals (money() rounds to cents, which is wrong for fractional shares).
const optQty = (v: unknown, name: string) => {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1e12) bad(`${name} must be a number of 0 or more`);
  return Math.round(n * 1e6) / 1e6;
};
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "item";
const newId = (label: string) => `${slug(label)}-${crypto.randomUUID().slice(0, 6)}`;
const ticker = (v: unknown) => {
  const s = optStr(v, 10).toUpperCase();
  if (!s) return null;
  if (!validSymbol(s)) bad("Ticker must be letters/numbers (e.g. SPCX)");
  return s;
};

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
// Deal names must be unique (case-insensitive). `exceptId` lets a deal keep its own name.
async function assertUniqueDealName(name: string, exceptId?: string, existing?: Deal[], hint = "") {
  if ((existing ?? (await listAll<Deal>(KINDS.deal))).some((x) => x.id !== exceptId && sameName(x.name, name))) bad(`A deal with that name already exists${hint}`);
}
// `today()` is the date in the club's own time zone, not UTC (at 8pm Eastern the UTC date is already tomorrow).
// The date a share count is valid from: never in the future (a future date would hide real splits).
const sharesDate = (v: unknown) => {
  const s = dateStr(v, "Share count as-of date");
  if (s > today()) bad("Share count as-of date can't be in the future");
  return s;
};

function buildDeal(body: any): Deal {
  const name = str(body.name, "Deal name");
  const hasValue = !(body.manualValue === "" || body.manualValue == null);
  const sharesHeld = optQty(body.sharesHeld, "Shares held");
  return {
    id: newId(name),
    name,
    channel: body.channel === "individual" ? "individual" : "club",
    ticker: ticker(body.ticker),
    sharesHeld,
    sharesAsOf: sharesHeld === null ? null : body.sharesAsOf ? sharesDate(body.sharesAsOf) : today(),
    manualValue: optMoney(body.manualValue, "Current value"),
    valueSource: !hasValue ? "estimate" : body.valueSource === "statement" ? "statement" : "estimate", // a typed-in value is an estimate unless it is explicitly marked as from a statement
    valueAsOf: !hasValue ? null : body.valueAsOf ? dateStr(body.valueAsOf, "Value as-of date") : today(),
    mgmtFeePct: optPct(body.mgmtFeePct, "Management fee"),
    carryPct: optPct(body.carryPct, "Carry"),
    notes: optStr(body.notes),
    valueHistory: [],
  };
}

export default async (req: Request) => {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const [resource, id] = parts;
  const method = req.method;
  // Who is calling? Admin, or a person whose stored sign-in is still the one the cookie was issued for.
  let session: Session | null = await readSession(req);
  let me: Person | null = null;
  if (session?.kind === "person") {
    const [person, rec] = await Promise.all([getOne<Person>(KINDS.person, session.personId), getAuth(session.personId)]);
    if (person && rec && rec.ver === session.ver) me = person;
    else session = null; // passcode was changed/removed, or the person was deleted
  }
  const isAdmin = session?.kind === "admin";

  if (resource === "session" && method === "GET") {
    return json(session ? { role: isAdmin ? "admin" : "person", name: me?.name ?? null, type: me?.type ?? null } : { role: null });
  }
  if (resource === "logout" && method === "POST") return json({ ok: true }, 200, { "set-cookie": clearCookie() });
  if (!session) return fail("Please sign in", 401);

  const loadView = async (viewer: Viewer) => {
    const [people, deals, holdings] = await Promise.all([listAll<Person>(KINDS.person), listAll<Deal>(KINDS.deal), listAll<Holding>(KINDS.holding)]);
    const quotes = await cachedQuotes(deals.map((d) => d.ticker).filter(Boolean) as string[]);
    return buildView(viewer, people, deals, holdings, quotes);
  };
  // The admin can preview exactly what a given person sees (?as=<personId>).
  const viewerFor = async (): Promise<Viewer> => {
    const as = url.searchParams.get("as");
    if (as && isAdmin) {
      const p = await getOne<Person>(KINDS.person, as);
      if (!p) bad("Unknown person");
      return { kind: "person", person: p! };
    }
    return isAdmin ? { kind: "admin" } : { kind: "person", person: me! };
  };

  try {
    if (resource === "data" && method === "GET") {
      await ensureSeeded();
      const view = await loadView(await viewerFor());
      const extra: Record<string, unknown> = {};
      if (isAdmin && !url.searchParams.get("as")) {
        extra.splitStatus = (await store().get("meta/splits-status", { type: "json" }).catch(() => null)) as SplitStatus | null;
        const auth = await listAll<AuthRecord>("auth");
        extra.passcodes = Object.fromEntries(auth.map((a) => [a.id, a.updatedAt]));
      }
      return json({ ...view, previewOf: url.searchParams.get("as") && isAdmin ? url.searchParams.get("as") : null, ...extra });
    }

    if (resource === "prices" && method === "GET") {
      const view = await loadView(await viewerFor()); // only tickers this person is allowed to see
      const tickers = view.deals.map((d) => d.ticker).filter(Boolean) as string[];
      return json(await getQuotes(tickers));
    }

    // Everything below changes data and needs the admin passcode.
    if (!isAdmin) return fail("Admin access required", 403);
    if (resource === "export" && method === "GET") {
      const [people, deals, holdings] = await Promise.all([listAll<Person>(KINDS.person), listAll<Deal>(KINDS.deal), listAll<Holding>(KINDS.holding)]);
      const stamp = today();
      return new Response(JSON.stringify({ exportedAt: new Date().toISOString(), people, deals, holdings }, null, 2), {
        headers: { "content-type": "application/json", "cache-control": "no-store", "content-disposition": `attachment; filename="pari-passu-backup-${stamp}.json"` },
      });
    }
    if (resource === "splits" && id === "check" && method === "POST") return json(await checkSplits());
    if (method !== "GET" && !(req.headers.get("content-type") || "").includes("application/json")) return fail("Expected JSON", 415);
    let body: any = {};
    if (method === "POST" || method === "PUT") {
      body = await req.json().catch(() => bad("Invalid JSON"));
      if (!body || typeof body !== "object" || Array.isArray(body)) bad("Invalid JSON"); // JSON "null", numbers etc. parse fine but are not a request
    }

    if (resource === "people") {
      // Personal sign-in passcode for one person (admin sets or removes it; it is stored hashed and never shown again).
      if (id && parts[2] === "passcode" && method === "PUT") {
        if (!(await getOne<Person>(KINDS.person, id))) return fail("Not found", 404);
        const code = String(body.passcode ?? "");
        if (code.length < 8 || code.length > 100) bad("Passcode must be at least 8 characters");
        const rec: AuthRecord = { id, ...(await hashPasscode(code)), ver: crypto.randomUUID().replace(/-/g, "").slice(0, 12), updatedAt: new Date().toISOString() };
        await putAuth(rec); // new `ver` signs out any session this person already had
        return json({ ok: true, updatedAt: rec.updatedAt });
      }
      if (id && parts[2] === "passcode" && method === "DELETE") {
        await deleteAuth(id);
        return json({ ok: true });
      }
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
        const name = str(body.name ?? p.name, "Name", 60);
        const others = await listAll<Person>(KINDS.person);
        if (others.some((o) => o.id !== p.id && o.name.toLowerCase() === name.toLowerCase())) bad("Someone else already has that name");
        p.name = name;
        p.type = body.type === "member" ? "member" : "non-member";
        await putOne(KINDS.person, p);
        return json(p);
      }
      if (method === "DELETE" && id) {
        const holdings = await listAll<Holding>(KINDS.holding);
        const n = holdings.filter((h) => h.personId === id).length;
        if (n) return fail(`This person still has ${n} holding${n === 1 ? "" : "s"}. Delete or reassign them first.`, 409);
        await deleteOne(KINDS.person, id);
        await deleteAuth(id);
        return json({ ok: true });
      }
    }

    if (resource === "deals") {
      if (method === "POST") {
        const deal = buildDeal(body);
        await assertUniqueDealName(deal.name);
        await putOne(KINDS.deal, deal);
        return json(deal, 201);
      }
      if (method === "PUT" && id) {
        const d = await getOne<Deal>(KINDS.deal, id);
        if (!d) return fail("Not found", 404);
        const newName = str(body.name ?? d.name, "Name");
        if (!sameName(newName, d.name)) await assertUniqueDealName(newName, d.id); // only when the name is actually being changed
        d.name = newName;
        d.channel = body.channel === "individual" ? "individual" : "club";
        d.ticker = ticker(body.ticker);
        // The form remembers the share count it was opened with. If a split was applied since, and the admin did not touch the
        // box, keep the split-adjusted count instead of silently putting the old one back.
        const typedShares = optQty(body.sharesHeld, "Shares held");
        const was = body.sharesHeldWas === undefined ? undefined : optQty(body.sharesHeldWas, "Shares held");
        const untouched = was !== undefined && typedShares === was;
        const nextShares = untouched ? d.sharesHeld ?? null : typedShares;
        if (nextShares === null) {
          d.sharesAsOf = null;
        } else if (body.sharesAsOf && body.sharesAsOf !== d.sharesAsOf) {
          d.sharesAsOf = sharesDate(body.sharesAsOf); // an explicit as-of date from the admin
        } else if (nextShares !== (d.sharesHeld ?? null) || !d.sharesAsOf) {
          d.sharesAsOf = today(); // a new count is valid from today
        }
        d.sharesHeld = nextShares;
        d.mgmtFeePct = optPct(body.mgmtFeePct, "Management fee");
        d.carryPct = optPct(body.carryPct, "Carry");
        d.notes = optStr(body.notes);
        const nextValue = optMoney(body.manualValue, "Current value");
        const keepPlaceholder = body.valueSource === "placeholder" && d.valueSource === "placeholder" && nextValue === d.manualValue;
        const nextSource = ["statement", "estimate"].includes(body.valueSource) ? body.valueSource : keepPlaceholder ? "placeholder" : "estimate";
        if (nextValue !== d.manualValue || nextSource !== d.valueSource) {
          d.valueHistory = [...(d.valueHistory ?? []), { at: new Date().toISOString(), value: d.manualValue, source: d.valueSource, note: optStr(body.valueNote, 200) }].slice(-50);
          d.manualValue = nextValue;
          d.valueSource = nextSource;
          d.valueAsOf = body.valueAsOf ? dateStr(body.valueAsOf, "Value as-of date") : today();
        } else if (body.valueAsOf && body.valueAsOf !== d.valueAsOf) {
          d.valueAsOf = dateStr(body.valueAsOf, "Value as-of date"); // an explicit correction of the date only
        }
        await putOne(KINDS.deal, d);
        return json(d);
      }
      if (method === "DELETE" && id) {
        const mine = (await listAll<Holding>(KINDS.holding)).filter((h) => h.dealId === id);
        if (mine.length && url.searchParams.get("cascade") !== "1") return fail("This deal still has holdings. Confirm deleting them too.", 409);
        for (const h of mine) await deleteOne(KINDS.holding, h.id);
        await deleteOne(KINDS.deal, id);
        return json({ ok: true, holdingsDeleted: mine.length });
      }
    }

    // Guided "add investment": validates everything first, then writes (new people, new deal, holdings).
    if (resource === "investments" && method === "POST") {
      const [people, deals] = await Promise.all([listAll<Person>(KINDS.person), listAll<Deal>(KINDS.deal)]);
      const date = dateStr(body.date, "Investment date");
      let deal: Deal | undefined;
      let isNewDeal = false;
      if (body.dealId) {
        deal = deals.find((d) => d.id === body.dealId);
        if (!deal) bad("Unknown deal");
      } else {
        deal = buildDeal(body.deal ?? {});
        isNewDeal = true;
        await assertUniqueDealName(deal.name, undefined, deals, " - choose it as an existing deal instead");
      }
      const investors: any[] = Array.isArray(body.investors) ? body.investors : [];
      if (!investors.length) bad("Add at least one investor");
      if (investors.length > 40) bad("Too many investors in one go");
      const known = [...people];
      const newPeople: Person[] = [];
      const seen = new Set<string>();
      const holdings: Holding[] = [];
      for (const inv of investors) {
        if (!inv || typeof inv !== "object") bad("Each investor needs a person and an amount");
        let person: Person | undefined;
        if (inv.newPerson) {
          const name = str(inv.newPerson.name, "Name", 60);
          if (known.some((p) => p.name.toLowerCase() === name.toLowerCase())) bad(`${name} already exists - pick them from the list instead`);
          person = { id: newId(name), name, type: inv.newPerson.type === "member" ? "member" : "non-member", order: Math.max(0, ...known.map((p) => p.order)) + 1 };
          known.push(person);
          newPeople.push(person);
        } else {
          person = known.find((p) => p.id === inv.personId);
          if (!person) bad("Choose who invested");
        }
        if (seen.has(person!.id)) bad(`${person!.name} is listed twice`);
        seen.add(person!.id);
        const invested = money(inv.invested, `${person!.name}'s amount`);
        if (invested <= 0) bad(`${person!.name}'s amount must be more than $0`);
        holdings.push({ id: crypto.randomUUID().slice(0, 8), dealId: deal!.id, personId: person!.id, date, invested, distributions: 0 });
      }
      for (const p of newPeople) await putOne(KINDS.person, p);
      if (isNewDeal) await putOne(KINDS.deal, deal!);
      for (const h of holdings) await putOne(KINDS.holding, h);
      return json({ deal, holdings, newPeople }, 201);
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

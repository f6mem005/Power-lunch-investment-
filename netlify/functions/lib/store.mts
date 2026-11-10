import { getStore } from "@netlify/blobs";
import seed from "./seed.json" with { type: "json" };

export type Person = { id: string; name: string; type: "member" | "non-member"; order: number };
export type ValueEntry = { at: string; value: number | null; source: string; note: string };
// One recorded stock split applied to a deal's share count.
export type SplitEntry = { date: string; from: number; to: number; before: number; after: number; appliedAt: string; source: string };
export type Deal = {
  id: string;
  name: string;
  channel: "club" | "individual";
  ticker: string | null;
  sharesHeld: number | null;
  splitLog?: SplitEntry[];
  manualValue: number | null;
  valueSource: "placeholder" | "statement" | "estimate";
  valueAsOf: string | null;
  mgmtFeePct: number | null; // upfront management fee, % of amount invested (taken out of the amount invested)
  carryPct: number | null; // carry, % of profit (no hurdle)
  notes: string;
  valueHistory: ValueEntry[];
};
export type Holding = {
  id: string;
  dealId: string;
  personId: string;
  date: string;
  invested: number;
  distributions: number;
};

export type AuthRecord = { id: string; salt: string; hash: string; iter: number; ver: string; updatedAt: string };

export const KINDS = { person: "people", deal: "deals", holding: "holdings" } as const;

// Strong consistency so an admin sees their own edits immediately.
export const store = () => getStore({ name: "plc-data", consistency: "strong" });

export async function listAll<T>(prefix: string): Promise<T[]> {
  const s = store();
  const { blobs } = await s.list({ prefix: `${prefix}/` });
  const items = await Promise.all(blobs.map((b) => s.get(b.key, { type: "json" })));
  return items.filter((x) => x !== null) as T[];
}

export async function getOne<T>(prefix: string, id: string): Promise<T | null> {
  return (await store().get(`${prefix}/${id}`, { type: "json" })) as T | null;
}

export async function putOne(prefix: string, record: { id: string }) {
  await store().setJSON(`${prefix}/${record.id}`, record);
}

export async function deleteOne(prefix: string, id: string) {
  await store().delete(`${prefix}/${id}`);
}

// One-time import of the original spreadsheet. Writes are onlyIfNew, so concurrent first
// loads are safe, and the flag is set last so a partial failure retries on the next load.
export async function ensureSeeded() {
  const s = store();
  if (await s.get("meta/seeded")) return;
  for (const p of seed.people) await s.setJSON(`people/${p.id}`, p, { onlyIfNew: true });
  for (const d of seed.deals) await s.setJSON(`deals/${d.id}`, d, { onlyIfNew: true });
  for (const h of seed.holdings) await s.setJSON(`holdings/${h.id}`, h, { onlyIfNew: true });
  await s.setJSON("meta/seeded", { at: new Date().toISOString(), source: "Power Lunch Club Investments (Google Sheet)" });
}

export const getAuth = (personId: string) => getOne<AuthRecord>("auth", personId);
export const putAuth = (rec: AuthRecord) => putOne("auth", rec);
export const deleteAuth = (personId: string) => deleteOne("auth", personId);

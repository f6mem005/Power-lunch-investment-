import type { Config } from "@netlify/functions";
import { DUMMY, checkAdminPasscode, isConfigured, makeCookie, verifyPasscode } from "./lib/auth.mts";
import { KINDS, getAuth, listAll } from "./lib/store.mts";
import type { Person } from "./lib/store.mts";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
const DENIED = "Incorrect name or passcode";

export default async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!isConfigured()) return json({ error: "Sign-in is not configured yet. Set SESSION_SECRET and ADMIN_PASSCODE." }, 503);
  let name = "";
  let passcode = "";
  try {
    const b = await req.json();
    name = String(b.name ?? "").trim();
    passcode = String(b.passcode ?? "");
  } catch {
    return json({ error: "Bad request" }, 400);
  }
  if (!passcode) return json({ error: DENIED }, 401);

  // Blank name = the admin passcode.
  if (!name) {
    if (!(await checkAdminPasscode(passcode))) return json({ error: DENIED }, 401);
    return json({ role: "admin" }, 200, { "set-cookie": await makeCookie({ kind: "admin" }) });
  }

  const people = await listAll<Person>(KINDS.person);
  const person = people.find((p) => p.name.toLowerCase() === name.toLowerCase());
  const rec = person ? await getAuth(person.id) : null;
  const ok = await verifyPasscode(passcode, rec ?? DUMMY); // always does the work, even for unknown names
  if (!person || !rec || !ok) return json({ error: DENIED }, 401);
  return json({ role: "person", name: person.name }, 200, { "set-cookie": await makeCookie({ kind: "person", personId: person.id, ver: rec.ver }) });
};

export const config: Config = {
  path: "/auth/login",
  // Brute-force guard: 10 attempts per minute per IP.
  rateLimit: { windowLimit: 10, windowSize: 60, aggregateBy: ["ip", "domain"] },
};

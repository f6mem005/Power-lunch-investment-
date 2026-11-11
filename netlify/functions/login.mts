import type { Config } from "@netlify/functions";
import { DUMMY, checkAdminPasscode, isConfigured, makeCookie, verifyPasscode } from "./lib/auth.mts";
import { KINDS, getAuth, listAll } from "./lib/store.mts";
import type { Person } from "./lib/store.mts";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
const DENIED = "Incorrect name or passcode";
const MAX_PASSCODE = 200; // a real passcode is at most 100 characters (the admin form's limit); never hash anything much longer

// The forms of a typed passcode that are checked. Surrounding whitespace is always forgiven (a pasted value often carries a trailing
// space or newline). `lower` also tries it in lowercase, for personal passcodes: generated ones are all lowercase, and a text message
// starts with a capital. A passcode that was set with capitals still has to be typed with them. Every form is always checked, so
// the work done doesn't reveal which one matched, and unknown names do the same work against a dummy record.
const forms = (passcode: string, lower: boolean) => [...new Set([passcode, passcode.trim(), lower ? passcode.trim().toLowerCase() : passcode.trim()])].filter(Boolean);

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
  if (!passcode || passcode.length > MAX_PASSCODE) return json({ error: DENIED }, 401);

  // Blank name = the admin passcode.
  if (!name) {
    if (!(await Promise.all(forms(passcode, false).map((f) => checkAdminPasscode(f)))).some(Boolean)) return json({ error: DENIED }, 401);
    return json({ role: "admin" }, 200, { "set-cookie": await makeCookie({ kind: "admin" }) });
  }

  const people = await listAll<Person>(KINDS.person);
  const person = people.find((p) => p.name.toLowerCase() === name.toLowerCase());
  const rec = person ? await getAuth(person.id) : null;
  const ok = (await Promise.all(forms(passcode, true).map((f) => verifyPasscode(f, rec ?? DUMMY)))).some(Boolean);
  if (!person || !rec || !ok) return json({ error: DENIED }, 401);
  return json({ role: "person", name: person.name }, 200, { "set-cookie": await makeCookie({ kind: "person", personId: person.id, ver: rec.ver }) });
};

export const config: Config = {
  path: "/auth/login",
  // Brute-force guard: 10 attempts per minute per IP.
  rateLimit: { windowLimit: 10, windowSize: 60, aggregateBy: ["ip", "domain"] },
};

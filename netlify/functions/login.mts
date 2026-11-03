import type { Config } from "@netlify/functions";
import { checkPasscode, isConfigured, makeCookie } from "./lib/auth.mts";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

export default async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!isConfigured()) return json({ error: "Login is not configured yet. Set SESSION_SECRET, VIEWER_PASSCODE and ADMIN_PASSCODE." }, 503);
  let passcode = "";
  try {
    passcode = String((await req.json()).passcode ?? "");
  } catch {
    return json({ error: "Bad request" }, 400);
  }
  const role = await checkPasscode(passcode);
  if (!role) return json({ error: "Incorrect passcode" }, 401);
  return json({ role }, 200, { "set-cookie": await makeCookie(role) });
};

export const config: Config = {
  path: "/auth/login",
  // Brute-force guard: 10 attempts per minute per IP.
  rateLimit: { windowLimit: 10, windowSize: 60, aggregateBy: ["ip", "domain"] },
};

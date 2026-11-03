// Passcode auth with two roles. Fails closed: if the env vars are missing, nobody gets in.
export type Role = "viewer" | "admin";

const enc = new TextEncoder();
const COOKIE = "plc_session";
export const SESSION_SECONDS = 60 * 60 * 24 * 14;

const b64url = (buf: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function hmac(secret: string, data: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const secrets = () => ({
  secret: Netlify.env.get("SESSION_SECRET") || "",
  viewer: Netlify.env.get("VIEWER_PASSCODE") || "",
  admin: Netlify.env.get("ADMIN_PASSCODE") || "",
});

export const isConfigured = () => {
  const s = secrets();
  return s.secret.length >= 16 && !!s.viewer && !!s.admin;
};

// Compares HMACs of both values so length and content don't leak through timing.
export async function checkPasscode(input: string): Promise<Role | null> {
  const s = secrets();
  if (!isConfigured() || !input) return null;
  const probe = await hmac(s.secret, `pc:${input}`);
  const admin = safeEqual(probe, await hmac(s.secret, `pc:${s.admin}`));
  const viewer = safeEqual(probe, await hmac(s.secret, `pc:${s.viewer}`));
  return admin ? "admin" : viewer ? "viewer" : null;
}

export async function makeCookie(role: Role) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const payload = `${role}.${exp}`;
  const sig = await hmac(secrets().secret, `sess:${payload}`);
  return `${COOKIE}=${payload}.${sig}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}`;
}

export const clearCookie = () => `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;

export async function getRole(req: Request): Promise<Role | null> {
  if (!isConfigured()) return null;
  const raw = req.headers.get("cookie") || "";
  const match = raw.split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  if (!match) return null;
  const [role, exp, sig] = match.slice(COOKIE.length + 1).split(".");
  if (!role || !exp || !sig || (role !== "viewer" && role !== "admin")) return null;
  if (Number(exp) < Date.now() / 1000) return null;
  const expected = await hmac(secrets().secret, `sess:${role}.${exp}`);
  return safeEqual(sig, expected) ? role : null;
}

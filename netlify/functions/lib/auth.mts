// Sign-in: the admin uses one passcode (env var); everyone else has a personal passcode set by the admin.
// Sessions are signed cookies. Fails closed: with no SESSION_SECRET / ADMIN_PASSCODE nobody can sign in.
export type Session = { kind: "admin" } | { kind: "person"; personId: string; ver: string };

const enc = new TextEncoder();
const COOKIE = "plc_session";
export const SESSION_SECONDS = 60 * 60 * 24 * 14;
const ITERATIONS = 100_000;

const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf as ArrayBuffer))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

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

export const secrets = () => ({ secret: Netlify.env.get("SESSION_SECRET") || "", admin: Netlify.env.get("ADMIN_PASSCODE") || "" });
export const isConfigured = () => {
  const s = secrets();
  return s.secret.length >= 16 && !!s.admin;
};

// ---- personal passcodes (PBKDF2, salted) ----
async function pbkdf2(passcode: string, salt: Uint8Array, iter: number) {
  const key = await crypto.subtle.importKey("raw", enc.encode(passcode), "PBKDF2", false, ["deriveBits"]);
  return b64url(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256));
}
export async function hashPasscode(passcode: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { salt: b64url(salt), hash: await pbkdf2(passcode, salt, ITERATIONS), iter: ITERATIONS };
}
export async function verifyPasscode(passcode: string, rec: { salt: string; hash: string; iter: number }) {
  return safeEqual(await pbkdf2(passcode, fromB64url(rec.salt), rec.iter), rec.hash);
}
// Used when the name is unknown so the response time doesn't reveal which names exist.
export const DUMMY = { salt: "AAAAAAAAAAAAAAAAAAAAAA", hash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", iter: ITERATIONS };

// Compares HMACs of both values so length and content don't leak through timing.
export async function checkAdminPasscode(input: string) {
  const s = secrets();
  if (!isConfigured() || !input) return false;
  return safeEqual(await hmac(s.secret, `pc:${input}`), await hmac(s.secret, `pc:${s.admin}`));
}

// ---- session cookie ----
// Admin cookies carry a fingerprint of the current ADMIN_PASSCODE, so changing the passcode signs every admin session out.
const adminVer = async () => (await hmac(secrets().secret, `adminver:${secrets().admin}`)).slice(0, 16);
export async function makeCookie(session: Session) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const who = session.kind === "admin" ? `a::${await adminVer()}` : `p:${session.personId}:${session.ver}`;
  const sig = await hmac(secrets().secret, `sess:${who}.${exp}`);
  return `${COOKIE}=${who}.${exp}.${sig}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}`;
}
export const clearCookie = () => `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;

// Verifies the signature and expiry only. The caller must still check a person session's `ver` against the stored record.
export async function readSession(req: Request): Promise<Session | null> {
  if (!isConfigured()) return null;
  const raw = (req.headers.get("cookie") || "").split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  if (!raw) return null;
  const [who, exp, sig] = raw.slice(COOKIE.length + 1).split(".");
  if (!who || !exp || !sig || Number(exp) < Date.now() / 1000) return null;
  if (!safeEqual(sig, await hmac(secrets().secret, `sess:${who}.${exp}`))) return null;
  const [kind, personId, ver] = who.split(":");
  if (kind === "a") return ver && safeEqual(ver, await adminVer()) ? { kind: "admin" } : null;
  if (kind === "p" && personId && ver) return { kind: "person", personId, ver };
  return null;
}

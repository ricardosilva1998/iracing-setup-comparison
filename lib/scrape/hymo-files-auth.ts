/**
 * HYMO Setups file-download auth helper.
 *
 * HYMO uses a flat Bearer token (not Cognito PKCE). Login is a simple
 * POST /api/v1/login returning { access_token, refresh_token, expires_in }.
 * expires_in is 3600s; we cache for 50 minutes to avoid using an
 * about-to-expire token mid-request.
 *
 * Exported:
 *   getHymoToken()               -> string (Bearer value)
 *   invalidateHymoTokenCache()   -> void   (call on 401 for retry-once)
 *
 * Utility helpers re-exported from grid-and-go-auth so callers only
 * need one import:
 *   redact, safeUrl, sanitise
 */
import "dotenv/config";
export { redact, safeUrl, sanitise } from "@/lib/scrape/grid-and-go-auth";
import { redact, sanitise } from "@/lib/scrape/grid-and-go-auth";

const LOGIN_URL = "https://api.hymosetups.com/api/v1/login";
// 50 minutes — refresh 10 min before the 1-hour server-issued TTL.
const TOKEN_TTL_MS = 50 * 60 * 1000;

let cachedToken: { value: string; expiresAt: number } | null = null;

/**
 * Returns a valid HYMO Bearer token, logging in if the cache is empty or
 * expired. Throws (without leaking the password) if the env vars are missing
 * or the login request fails.
 */
export async function getHymoToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < cachedToken.expiresAt) {
    const remainingSecs = Math.round((cachedToken.expiresAt - now) / 1000);
    console.log(`[hymo-auth] using cached token (expires in ${remainingSecs}s)`);
    return cachedToken.value;
  }

  const email = process.env.HYMO_EMAIL;
  const password = process.env.HYMO_PASSWORD;
  if (!email || !password) {
    throw new Error("missing HYMO_EMAIL or HYMO_PASSWORD in env");
  }
  const secrets = [email, password];
  console.log(`[hymo-auth] logging in (email=${redact(email)})`);

  let resp: Response;
  try {
    resp = await fetch(LOGIN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, remember_me: false }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    const msg = sanitise(String((err as Error).message ?? err), secrets);
    throw new Error(`hymo-auth: network error during login: ${msg}`);
  }

  if (!resp.ok) {
    let body = "";
    try { body = await resp.text(); } catch { /* ignore */ }
    const safeBody = sanitise(body.slice(0, 200), secrets);
    throw new Error(
      `hymo-auth: login returned HTTP ${resp.status}: ${safeBody}`,
    );
  }

  // HYMO login response shape: { status: true, message: "...", data: { access_token, ... } }
  // The token lives under the `data` envelope, not at the root.
  let raw: { status?: boolean; data?: { access_token?: string; expires_in?: number } };
  try {
    raw = await resp.json() as typeof raw;
  } catch {
    throw new Error("hymo-auth: login response is not valid JSON");
  }

  const token = raw?.data?.access_token;
  if (!token) {
    throw new Error("hymo-auth: login succeeded but no data.access_token in response");
  }

  console.log(`[hymo-auth] authenticated. access_token length=${token.length}`);
  cachedToken = { value: token, expiresAt: Date.now() + TOKEN_TTL_MS };
  return token;
}

/** Invalidate the in-process token cache (call this on 401 from the API). */
export function invalidateHymoTokenCache(): void {
  cachedToken = null;
}

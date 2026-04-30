/**
 * Grid-and-Go shared Cognito auth helper.
 *
 * Encapsulates the Playwright login flow and token extraction. Caches the
 * access_token + id_token in module scope with a 50-minute TTL (Cognito's
 * default token lifetime is ~1h; we refresh 10 min early to avoid using an
 * about-to-expire token mid-request).
 *
 * Exported by this module:
 *   getGngTokens()        -> { accessToken, idToken }
 *   invalidateGngTokenCache()  -> void
 *
 * The GnG datapacks catalog endpoint (/datapacks?year=&season=) uses the
 * id_token (verified in round 2). The per-datapack detail endpoint
 * (/datapacks/<id>) uses the access_token (observed in the Phase A probe:
 * intercepted request showed <bearer length=1132> vs id_token length=1202).
 * Both tokens are returned so callers can pick the right one.
 *
 * Secret hygiene:
 *   - Creds read from env only. Never logged (only redacted lengths).
 *   - Token values never written to disk or DB.
 *   - safeUrl() / sanitise() on all log lines.
 *   - No traces, no videos, no screenshots.
 */

export type GngTokens = {
  accessToken: string;
  idToken: string;
};

const APP_HOST = "https://app.grid-and-go.com";

export function redact(value: string | undefined): string {
  if (!value) return "<missing>";
  return `<set length=${value.length}>`;
}

export function safeUrl(u: string): string {
  try {
    const parsed = new URL(u);
    const stripParams = [
      "code", "code_challenge", "code_verifier", "state",
      "id_token", "access_token", "refresh_token", "session",
    ];
    for (const p of stripParams) parsed.searchParams.delete(p);
    return parsed.origin + parsed.pathname + (parsed.search ? `?${parsed.searchParams.toString()}` : "");
  } catch {
    return "<unparseable url>";
  }
}

export function sanitise(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s) out = out.split(s).join("<REDACTED>");
  }
  return out;
}

// Module-scope token cache. Never persisted beyond the process lifetime.
let cachedTokens: GngTokens | null = null;
let cacheExpiresAt = 0;
// 50 minutes — refresh 10 min before Cognito's ~1h expiry.
const TOKEN_TTL_MS = 50 * 60 * 1000;

/**
 * Returns cached tokens if still valid, otherwise performs a fresh Playwright
 * Cognito login and caches the result.
 *
 * Lazy-imports playwright so the Next.js standalone build trace does not try
 * to bundle the Chromium binary from every import site.
 */
export async function getGngTokens(): Promise<GngTokens> {
  const now = Date.now();
  if (cachedTokens && now < cacheExpiresAt) {
    const remainingSecs = Math.round((cacheExpiresAt - now) / 1000);
    console.log(`[gng-auth] using cached tokens (expires in ${remainingSecs}s)`);
    return cachedTokens;
  }

  const email = process.env.GRID_AND_GO_EMAIL;
  const password = process.env.GRID_AND_GO_PASSWORD;
  if (!email || !password) {
    throw new Error("missing GRID_AND_GO_EMAIL or GRID_AND_GO_PASSWORD in env");
  }
  const secrets = [email, password];
  console.log(`[gng-auth] logging in (email=${redact(email)})`);

  let chromiumMod: typeof import("playwright") | null = null;
  try {
    chromiumMod = await import("playwright");
  } catch (err) {
    const msg = sanitise(String((err as Error).message || err), secrets);
    throw new Error(`playwright not available: ${msg}`);
  }
  const { chromium } = chromiumMod;

  const chromiumPath = process.env.CHROMIUM_PATH;
  console.log(
    `[gng-auth] launching headless chromium${chromiumPath ? ` (executablePath=${chromiumPath})` : " (bundled)"}`,
  );
  const browser = await chromium.launch({
    headless: true,
    executablePath: chromiumPath || undefined,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
  });

  try {
    const page = await context.newPage();

    await page.goto(`${APP_HOST}/`, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(6000);

    console.log("[gng-auth] triggering sign-in");
    const signInTrigger = page.locator(":has-text('SIGN IN')").last();
    await signInTrigger.click();
    await page.waitForURL(/amazoncognito\.com/, { timeout: 20000 });
    await page.waitForTimeout(3000);
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});

    const usernameSel = page.locator("input[name='username']:visible").first();
    const passwordSel = page.locator("input[name='password']:visible").first();
    const submitSel = page.locator("input[name='signInSubmitButton']:visible").first();

    await usernameSel.waitFor({ state: "visible", timeout: 15000 });
    await usernameSel.fill(email);
    await passwordSel.fill(password);
    await submitSel.click();
    await page.waitForURL(/app\.grid-and-go\.com/, { timeout: 30000 });
    console.log("[gng-auth] post-login redirect ok");
    await page.waitForTimeout(5000);

    // Extract tokens from localStorage.
    // The GnG SPA stores tokens under bare keys ("id_token", "access_token",
    // "refresh_token") rather than Cognito's namespaced pattern.
    // The per-datapack detail endpoint (/datapacks/<id>) requires access_token
    // (confirmed in Phase A probe: intercepted auth-length=1132 = len("Bearer ")+1125).
    // The catalog endpoint (/datapacks?year=&season=) uses id_token.
    const tokens = await page.evaluate(() => {
      const ls = localStorage;
      const keys = Object.keys(ls);
      // Prefer bare keys first (what this SPA actually writes).
      let idToken: string | null = ls.getItem("id_token");
      let accessToken: string | null = ls.getItem("access_token");
      // Fallback: Cognito namespaced keys (future-proofing).
      for (const k of keys) {
        if (k.endsWith(".idToken") && !idToken) idToken = ls.getItem(k);
        if (k.endsWith(".accessToken") && !accessToken) accessToken = ls.getItem(k);
      }
      return { idToken, accessToken };
    });

    if (!tokens.idToken) {
      throw new Error("login succeeded but no id_token found in localStorage");
    }
    // If no access_token is found, fall back to id_token for both slots.
    if (!tokens.accessToken) {
      console.log("[gng-auth] no access_token found; falling back to id_token for both slots");
      tokens.accessToken = tokens.idToken;
    }

    console.log(
      `[gng-auth] authenticated. id_token length=${tokens.idToken.length} accessToken length=${tokens.accessToken.length}`,
    );

    cachedTokens = { accessToken: tokens.accessToken, idToken: tokens.idToken };
    cacheExpiresAt = Date.now() + TOKEN_TTL_MS;
    return cachedTokens;
  } catch (err) {
    // Bust the cache so the next call tries a fresh login.
    cachedTokens = null;
    cacheExpiresAt = 0;
    const msg = sanitise(String((err as Error).message || err), secrets);
    throw new Error(`gng-auth login failed: ${msg}`);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

/** Invalidate the in-process token cache (call this on 401 from the API). */
export function invalidateGngTokenCache(): void {
  cachedTokens = null;
  cacheExpiresAt = 0;
}

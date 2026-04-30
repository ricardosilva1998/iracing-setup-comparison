/**
 * P1Doks auth probe (NOT a scraper).
 *
 * Round 11 artefact. Mirrors scripts/probe-grid-and-go.ts.
 *
 * Goal: walk the login flow once with Playwright, capture *structural* facts
 * (URLs hit, cookies set, post-login routes, auth model, captcha/MFA presence,
 * authenticated API shape), and exit.
 *
 * Hard rules:
 *   - Read creds from process.env. Never log them, never write them anywhere.
 *   - Print only structural / non-secret info: URLs (with sensitive query params
 *     stripped), HTTP statuses, cookie names (no values), DOM landmarks.
 *   - On error, sanitize messages so creds cannot leak via stack traces.
 *   - Run headless. Save NO traces / videos / screenshots that could embed
 *     form values.
 *   - Three previously-401 endpoints to retry while authenticated:
 *       /api/setups, /api/products, /api/telemetry/sessions/for-picker
 */
import "dotenv/config";
import { chromium } from "playwright";

function redact(value: string | undefined): string {
  if (!value) return "<missing>";
  return `<set length=${value.length}>`;
}

function safeUrl(u: string): string {
  try {
    const parsed = new URL(u);
    const stripParams = [
      "code",
      "code_challenge",
      "code_verifier",
      "state",
      "id_token",
      "access_token",
      "refresh_token",
      "session",
      "token",
      "auth",
      "jwt",
    ];
    for (const p of stripParams) parsed.searchParams.delete(p);
    return parsed.origin + parsed.pathname + (parsed.search ? `?${parsed.searchParams.toString()}` : "");
  } catch {
    return "<unparseable url>";
  }
}

function sanitise(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s) out = out.split(s).join("<REDACTED>");
  }
  return out;
}

function summariseValue(v: unknown, depth = 0): string {
  if (v === null) return "null";
  if (typeof v === "string") {
    return `string(${v.length})${v.length < 60 ? `="${v}"` : ""}`;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    return `array(${v.length})${v.length > 0 && depth < 1 ? "[" + summariseValue(v[0], depth + 1) + "]" : ""}`;
  }
  if (typeof v === "object") {
    const keys = Object.keys(v as Record<string, unknown>);
    return `object(${keys.length} keys: ${keys.slice(0, 12).join(", ")})`;
  }
  return typeof v;
}

async function main() {
  const email = process.env.P1DOKS_EMAIL;
  const password = process.env.P1DOKS_PASSWORD;
  console.log(`creds: email=${redact(email)} password=${redact(password)}`);
  if (!email || !password) {
    console.error("missing P1DOKS_EMAIL or P1DOKS_PASSWORD in .env");
    process.exit(1);
  }

  const secrets = [email, password];
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();

  const requests: { method: string; url: string; status?: number; resourceType: string }[] = [];
  page.on("request", (req) => {
    requests.push({
      method: req.method(),
      url: safeUrl(req.url()),
      resourceType: req.resourceType(),
    });
  });
  page.on("response", async (res) => {
    const last = requests[requests.length - 1];
    if (last && last.url === safeUrl(res.url())) {
      last.status = res.status();
    }
  });

  try {
    console.log("\n[1] navigate to https://p1doks.com");
    await page.goto("https://p1doks.com/", { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(4000);
    console.log(`  landed at: ${safeUrl(page.url())}`);

    const html1 = await page.content();
    const captchaHits = (html1.match(/recaptcha|hcaptcha|turnstile|cf-challenge/gi) || []).length;
    const mfaHits = (html1.match(/two[\s-]?factor|2fa|otp|verification code|authenticator/gi) || []).length;
    const auth0Hits = (html1.match(/auth0/gi) || []).length;
    const cognitoHits = (html1.match(/cognito|amazoncognito/gi) || []).length;
    const oktaHits = (html1.match(/okta/gi) || []).length;
    console.log(`  captcha markers: ${captchaHits}  mfa markers: ${mfaHits}`);
    console.log(`  auth0 markers: ${auth0Hits}  cognito markers: ${cognitoHits}  okta markers: ${oktaHits}`);
    console.log(`  body length: ${html1.length}`);

    const affordances = await page.evaluate(() => {
      const out: string[] = [];
      document.querySelectorAll("a, button, [role='button']").forEach((el) => {
        const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
        const href = (el as HTMLAnchorElement).href || "";
        if (txt && txt.length < 80) out.push(`${el.tagName}[${href.slice(0, 80)}]: ${txt}`);
      });
      return out.slice(0, 60);
    });
    console.log(`  affordances on landing:`);
    for (const t of affordances) console.log(`    ${t}`);

    console.log("\n[2] try to navigate to login");
    const loginCandidates = [
      "https://app.p1doks.com",
      "https://app.p1doks.com/login",
      "https://p1doks.com/login",
      "https://p1doks.com/auth/login",
    ];
    let loginPageUrl: string | null = null;

    for (const candidate of loginCandidates) {
      try {
        await page.goto(candidate, { waitUntil: "networkidle", timeout: 20000 });
        await page.waitForTimeout(3000);
        const url = page.url();
        console.log(`  ${candidate} -> ${safeUrl(url)}`);
        const hasInputs = await page.locator("input[type='email'], input[type='password'], input[name='email'], input[name='username'], input[name='password']").count();
        if (hasInputs > 0) {
          loginPageUrl = url;
          console.log(`    form inputs detected (${hasInputs}). this is the login page.`);
          break;
        }
        const headings = await page.locator("h1, h2").evaluateAll((els) =>
          els.map((e) => (e.textContent || "").trim()).filter(Boolean).slice(0, 5),
        );
        console.log(`    headings: ${headings.join(" / ")}`);
      } catch (err) {
        console.log(`  ${candidate} -> failed: ${sanitise(String((err as Error).message), secrets).slice(0, 80)}`);
      }
    }

    if (!loginPageUrl) {
      console.log("  No login form found via direct nav. Try clicking from landing.");
      await page.goto("https://p1doks.com/", { waitUntil: "networkidle", timeout: 30000 });
      await page.waitForTimeout(3000);
      const trigger = page.locator("a:has-text('Login'), a:has-text('Log in'), a:has-text('Sign in'), button:has-text('Login'), button:has-text('Sign in')").first();
      if (await trigger.count() > 0) {
        console.log("  clicking login trigger from landing");
        await trigger.click().catch(() => {});
        await page.waitForTimeout(6000);
        const url = page.url();
        console.log(`  after click -> ${safeUrl(url)}`);
        const hasInputs = await page.locator("input[type='email'], input[type='password'], input[name='email'], input[name='username'], input[name='password']").count();
        if (hasInputs > 0) {
          loginPageUrl = url;
          console.log(`    form inputs detected (${hasInputs}). this is the login page.`);
        }
      }
    }

    if (!loginPageUrl) {
      console.log("  GIVING UP on auto-finding login page. Probe ends here.");
      return;
    }

    console.log("\n[3] inspect login form structure");
    const formHtml = await page.content();
    const captchaHits2 = (formHtml.match(/recaptcha|hcaptcha|turnstile|cf-challenge|g-recaptcha/gi) || []).length;
    console.log(`  captcha markers on login page: ${captchaHits2}`);
    const formAction = await page.locator("form").first().getAttribute("action").catch(() => null);
    const formMethod = await page.locator("form").first().getAttribute("method").catch(() => null);
    console.log(`  form[action=${formAction || "<none>"}, method=${formMethod || "<none>"}]`);

    console.log("\n[4] submit credentials");
    const emailField = page.locator("input[type='email'], input[name='email'], input[name='username']").first();
    const passwordField = page.locator("input[type='password'], input[name='password']").first();
    const submitBtn = page.locator("button[type='submit'], input[type='submit'], button:has-text('Login'), button:has-text('Sign in'), button:has-text('Log in')").first();

    await emailField.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
    await emailField.fill(email);
    await passwordField.fill(password);
    await submitBtn.click();

    await page.waitForTimeout(8000);
    await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});

    const postSubmitUrl = page.url();
    console.log(`  post-submit URL: ${safeUrl(postSubmitUrl)}`);

    const errorEl = await page.locator(".error, [role='alert'], .errorMessage, .modal-error, [class*='error']").first();
    const errText = (await errorEl.textContent().catch(() => null)) || "";
    if (errText) console.log(`  error region: ${sanitise(errText.trim(), secrets).slice(0, 200)}`);

    const afterContent = await page.content();
    const mfaPostHits = (afterContent.match(/verification code|authenticator|sms code|enter the code|two[\s-]?factor/gi) || []).length;
    console.log(`  mfa markers after submit: ${mfaPostHits}`);

    const stillLooksLikeLogin = await page.locator("input[type='password']:visible").count();
    console.log(`  visible password input still present: ${stillLooksLikeLogin > 0}`);

    let loggedInPageFound = true;
    if (stillLooksLikeLogin > 0 && !errText) {
      console.log("  hmm, password input still visible and no error -- login may have failed silently or page may be MFA-gated. tail requests:");
      const recentReqs = requests.slice(-15);
      for (const r of recentReqs) {
        console.log(`    ${r.method.padEnd(6)} ${r.status ?? "---"} ${r.resourceType.padEnd(8)} ${r.url}`);
      }
      loggedInPageFound = false;
    }

    if (!loggedInPageFound) {
      console.log("  login DID NOT succeed. Probe ends.");
      return;
    }

    console.log("\n[5] post-login app inspection");
    const cookies = await context.cookies();
    console.log(`  cookie names: ${cookies.map((c) => c.name).sort().join(", ")}`);
    console.log(`  cookie hosts: ${Array.from(new Set(cookies.map((c) => c.domain))).join(", ")}`);
    console.log(`  cookie httpOnly count: ${cookies.filter((c) => c.httpOnly).length}/${cookies.length}`);
    console.log(`  cookie secure count: ${cookies.filter((c) => c.secure).length}/${cookies.length}`);

    const storage = await page.evaluate(() => {
      const ls = Object.keys(localStorage);
      const ss = Object.keys(sessionStorage);
      return { localStorage: ls, sessionStorage: ss };
    });
    console.log(`  localStorage keys: ${storage.localStorage.join(", ")}`);
    console.log(`  sessionStorage keys: ${storage.sessionStorage.join(", ")}`);

    const tokenLengths = await page.evaluate(() => {
      const out: Record<string, number> = {};
      for (const k of Object.keys(localStorage)) {
        const v = localStorage.getItem(k) || "";
        if (v.length > 50) out[k] = v.length;
      }
      return out;
    });
    console.log(`  long localStorage values (likely tokens): ${JSON.stringify(tokenLengths)}`);

    const headings = await page.locator("h1, h2, h3").evaluateAll((els) =>
      els.map((e) => (e.textContent || "").trim()).filter(Boolean).slice(0, 20),
    );
    console.log(`  headings: ${headings.join(" | ")}`);

    const internalLinks = await page.locator("a[href]").evaluateAll((els) => {
      const out = new Set<string>();
      for (const e of els) {
        const href = (e as HTMLAnchorElement).getAttribute("href") || "";
        if (href.startsWith("/") || href.includes("p1doks.com")) out.add(href.slice(0, 100));
      }
      return Array.from(out).slice(0, 40);
    });
    console.log(`  internal links: ${internalLinks.join(", ")}`);

    console.log("\n[6] tail recent XHR/fetch requests");
    const apiCalls = requests.filter((r) => r.resourceType === "xhr" || r.resourceType === "fetch").slice(-30);
    for (const r of apiCalls) {
      console.log(`  ${r.method.padEnd(6)} ${r.status ?? "---"} ${r.url}`);
    }

    console.log("\n[7] probe previously-401 endpoints with browser context (cookies/headers attached)");
    const probeBases = ["https://api.p1doks.com", "https://app.p1doks.com", "https://p1doks.com"];
    const probePaths = [
      "/api/setups",
      "/api/products",
      "/api/telemetry/sessions/for-picker",
      "/api/me",
      "/api/auth/me",
      "/api/user",
      "/api/v1/setups",
      "/api/v1/products",
      "/api/v1/telemetry/sessions",
    ];

    for (const base of probeBases) {
      for (const path of probePaths) {
        const url = `${base}${path}`;
        try {
          const r = await page.request.get(url, { timeout: 15000 });
          const status = r.status();
          if (status === 200) {
            const ctype = r.headers()["content-type"] || "";
            console.log(`  ${url} -> 200 (${ctype})`);
            if (ctype.includes("json")) {
              const body = await r.json().catch(() => null);
              if (body && typeof body === "object") {
                const top = body as Record<string, unknown>;
                console.log(`    shape: ${summariseValue(body)}`);
                let items: unknown[] | undefined;
                if (Array.isArray(body)) items = body as unknown[];
                else if (Array.isArray(top.items)) items = top.items as unknown[];
                else if (Array.isArray(top.data)) items = top.data as unknown[];
                else if (Array.isArray(top.results)) items = top.results as unknown[];
                if (items && items.length > 0) {
                  console.log(`    array length: ${items.length}`);
                  const first = items[0] as Record<string, unknown>;
                  if (first && typeof first === "object") {
                    const keys = Object.keys(first);
                    console.log(`    item keys: ${keys.join(", ")}`);
                    console.log(`    SAMPLE-0: ${JSON.stringify(first).slice(0, 600)}`);
                    if (items.length > 1) {
                      console.log(`    SAMPLE-1: ${JSON.stringify(items[1]).slice(0, 600)}`);
                    }
                  }
                } else if (top && typeof top === "object") {
                  const keys = Object.keys(top);
                  console.log(`    top-level keys: ${keys.join(", ")}`);
                  console.log(`    SAMPLE: ${JSON.stringify(body).slice(0, 600)}`);
                }
              }
            } else {
              const text = await r.text();
              console.log(`    text (truncated): ${text.slice(0, 300)}`);
            }
          } else if (status === 401 || status === 403) {
            console.log(`  ${url} -> ${status}`);
          } else if (status === 404) {
            // skip silently
          } else {
            console.log(`  ${url} -> ${status}`);
          }
        } catch (err) {
          console.log(`  ${url} -> ERROR: ${sanitise(String((err as Error).message), secrets).slice(0, 100)}`);
        }
        await page.waitForTimeout(800 + Math.random() * 600);
      }
    }

    console.log("\n[8] visit common authed routes to elicit API calls");
    const routesToVisit = [
      "/setups",
      "/products",
      "/dashboard",
      "/telemetry",
      "/library",
      "/store",
      "/iracing",
    ];
    const sniffed: { url: string; status: number; method: string }[] = [];

    for (const route of routesToVisit) {
      const fullUrl = `https://app.p1doks.com${route}`;
      try {
        await page.goto(fullUrl, { waitUntil: "networkidle", timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(3000);
        const url = page.url();
        const stillOnAuth = url.includes("login") || url.includes("auth");
        const newReqs = requests.filter((r) => (r.resourceType === "xhr" || r.resourceType === "fetch") && r.url.includes("p1doks.com")).slice(-12);
        console.log(`  ${route} -> ${safeUrl(url)} ${stillOnAuth ? "(redirected to auth)" : ""}`);
        for (const r of newReqs) {
          if (r.url.includes("/api/")) {
            sniffed.push({ url: r.url, status: r.status ?? 0, method: r.method });
          }
        }
      } catch (err) {
        console.log(`  ${route} -> nav error: ${sanitise(String((err as Error).message), secrets).slice(0, 80)}`);
      }
    }

    console.log("\n[9] sniffed authenticated API calls during dashboard nav (deduped):");
    const uniqueApi = new Map<string, { status: number; method: string }>();
    for (const r of sniffed) uniqueApi.set(r.url, { status: r.status, method: r.method });
    for (const [url, meta] of Array.from(uniqueApi.entries()).slice(0, 60)) {
      console.log(`  ${meta.method.padEnd(6)} ${meta.status} ${url}`);
    }

    console.log("\n[10] deep-dive on /api/* endpoints discovered above");
    for (const [url] of Array.from(uniqueApi.entries()).slice(0, 30)) {
      try {
        const r = await page.request.get(url, { timeout: 15000 });
        const status = r.status();
        const ctype = r.headers()["content-type"] || "";
        console.log(`  ${url} -> ${status} (${ctype})`);
        if (status === 200 && ctype.includes("json")) {
          const body = await r.json().catch(() => null);
          if (body) {
            console.log(`    shape: ${summariseValue(body)}`);
            const top = body as Record<string, unknown>;
            let items: unknown[] | undefined;
            if (Array.isArray(body)) items = body as unknown[];
            else if (Array.isArray(top.items)) items = top.items as unknown[];
            else if (Array.isArray(top.data)) items = top.data as unknown[];
            else if (Array.isArray(top.results)) items = top.results as unknown[];
            if (items && items.length > 0) {
              const first = items[0] as Record<string, unknown>;
              const keys = Object.keys(first || {});
              console.log(`    first item keys (${items.length} items): ${keys.join(", ")}`);
              console.log(`    SAMPLE: ${JSON.stringify(first).slice(0, 800)}`);
            } else {
              console.log(`    SAMPLE: ${JSON.stringify(body).slice(0, 800)}`);
            }
          }
        }
      } catch (err) {
        console.log(`  ${url} -> error: ${sanitise(String((err as Error).message), secrets).slice(0, 100)}`);
      }
      await page.waitForTimeout(1500);
    }
  } catch (err) {
    const msg = sanitise(String((err as Error).message || err), secrets);
    console.error(`probe failed: ${msg}`);
  } finally {
    await browser.close();
  }
}

main().catch(() => {
  console.error("probe crashed");
  process.exit(1);
});

/**
 * P1Doks auth probe -- step 2.
 *
 * Step 1 (scripts/probe-p1doks.ts) found:
 *   - Auth: AWS Cognito (ca-central-1), client id 6mu7svlaa4q8i1mvkeknhsruo8.
 *   - Tokens land in localStorage under CognitoIdentityServiceProvider.<clientId>.<userId>.{id,access,refresh}Token.
 *   - Real authenticated API host: https://api.p1doks.com.
 *   - Real endpoint examples seen during nav: POST /ql/data-packs, POST /users/subscription-status, POST /api/activity.
 *   - The SPA marketplace renders cars + lap times directly (e.g. "0:17.048", "0:58.222", "1:13.235").
 *
 * Step 2 goal: login again, then sniff the actual request headers used by the SPA, and
 * replay the discovered POST endpoints with the correct auth header (Bearer idToken vs
 * Bearer accessToken vs no header) to find the working call shape and inspect the JSON.
 *
 * Hard rules unchanged: no creds in logs, no traces, no screenshots.
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
    const stripParams = ["code", "code_challenge", "code_verifier", "state", "id_token", "access_token", "refresh_token", "session", "token", "auth", "jwt"];
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

  const intercepted: { url: string; method: string; headers: Record<string, string>; postData: string | null }[] = [];
  page.on("request", (req) => {
    const url = req.url();
    if (url.includes("api.p1doks.com")) {
      const headers = req.headers();
      const safeHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === "authorization") {
          safeHeaders[k] = `<bearer length=${v.length}>`;
        } else if (k.toLowerCase().includes("cookie")) {
          safeHeaders[k] = `<cookies length=${v.length}>`;
        } else {
          safeHeaders[k] = v;
        }
      }
      intercepted.push({
        method: req.method(),
        url: safeUrl(url),
        headers: safeHeaders,
        postData: req.postData(),
      });
    }
  });

  try {
    console.log("\n[1] login");
    await page.goto("https://p1doks.com/login", { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(2000);
    await page.locator("input[type='email'], input[name='email']").first().fill(email);
    await page.locator("input[type='password'], input[name='password']").first().fill(password);
    await page.locator("button[type='submit'], button:has-text('Login'), button:has-text('Sign in')").first().click();
    await page.waitForTimeout(8000);
    await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
    console.log(`  post-login URL: ${safeUrl(page.url())}`);

    console.log("\n[2] navigate /marketplace to elicit api calls");
    await page.goto("https://p1doks.com/marketplace", { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(8000);
    await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});

    console.log(`\n[3] intercepted api.p1doks.com requests (${intercepted.length}):`);
    const seenUrls = new Set<string>();
    for (const r of intercepted) {
      const key = `${r.method} ${r.url}`;
      if (seenUrls.has(key)) continue;
      seenUrls.add(key);
      console.log(`  ${r.method.padEnd(6)} ${r.url}`);
      console.log(`    headers: ${JSON.stringify(r.headers).slice(0, 600)}`);
      if (r.postData) {
        console.log(`    postData: ${r.postData.slice(0, 600)}`);
      }
    }

    const tokens = await page.evaluate(() => {
      const lsKeys = Object.keys(localStorage);
      const idKey = lsKeys.find((k) => k.endsWith(".idToken"));
      const accessKey = lsKeys.find((k) => k.endsWith(".accessToken"));
      const refreshKey = lsKeys.find((k) => k.endsWith(".refreshToken"));
      const userKey = lsKeys.find((k) => k === "user");
      return {
        idToken: idKey ? localStorage.getItem(idKey) : null,
        accessToken: accessKey ? localStorage.getItem(accessKey) : null,
        refreshToken: refreshKey ? localStorage.getItem(refreshKey) : null,
        userValue: userKey ? localStorage.getItem(userKey) : null,
      };
    });

    console.log(`\n[4] tokens (lengths only):`);
    console.log(`  idToken length: ${tokens.idToken?.length ?? 0}`);
    console.log(`  accessToken length: ${tokens.accessToken?.length ?? 0}`);
    console.log(`  refreshToken length: ${tokens.refreshToken?.length ?? 0}`);
    if (tokens.userValue) {
      const safeUser = sanitise(tokens.userValue, secrets).slice(0, 400);
      console.log(`  user (sanitised): ${safeUser}`);
    }

    console.log(`\n[5] replay intercepted POST calls`);
    const replayed = new Set<string>();
    for (const r of intercepted) {
      if (replayed.has(`${r.method} ${r.url}`)) continue;
      replayed.add(`${r.method} ${r.url}`);
      const fullUrl = r.url;
      const tries: Array<{ label: string; headers: Record<string, string> }> = [
        { label: "no-auth-header", headers: { "content-type": "application/json" } },
        { label: "bearer-idToken", headers: { "content-type": "application/json", authorization: `Bearer ${tokens.idToken ?? ""}` } },
        { label: "bearer-accessToken", headers: { "content-type": "application/json", authorization: `Bearer ${tokens.accessToken ?? ""}` } },
      ];
      for (const t of tries) {
        try {
          let resp;
          if (r.method === "POST") {
            resp = await page.request.post(fullUrl, {
              headers: t.headers,
              data: r.postData ? JSON.parse(r.postData) : {},
              timeout: 15000,
            });
          } else {
            resp = await page.request.get(fullUrl, {
              headers: t.headers,
              timeout: 15000,
            });
          }
          const status = resp.status();
          console.log(`  ${t.label.padEnd(20)} ${r.method.padEnd(6)} ${fullUrl} -> ${status}`);
          if (status === 200) {
            const ctype = resp.headers()["content-type"] || "";
            if (ctype.includes("json")) {
              const body = await resp.json().catch(() => null);
              if (body) {
                const top = body as Record<string, unknown>;
                const keys = Object.keys(top);
                console.log(`    keys: ${keys.join(", ")}`);
                let items: unknown[] | undefined;
                if (Array.isArray(body)) items = body as unknown[];
                else if (Array.isArray(top.items)) items = top.items as unknown[];
                else if (Array.isArray(top.data)) items = top.data as unknown[];
                else if (Array.isArray(top.results)) items = top.results as unknown[];
                else if (Array.isArray(top.dataPacks)) items = top.dataPacks as unknown[];
                else if (Array.isArray(top["data-packs"])) items = top["data-packs"] as unknown[];
                if (items && items.length > 0) {
                  console.log(`    array length: ${items.length}`);
                  const first = items[0] as Record<string, unknown>;
                  if (first && typeof first === "object") {
                    console.log(`    first item keys: ${Object.keys(first).join(", ")}`);
                    console.log(`    SAMPLE-0: ${JSON.stringify(first).slice(0, 1200)}`);
                    if (items.length > 1) console.log(`    SAMPLE-1: ${JSON.stringify(items[1]).slice(0, 800)}`);
                  }
                } else {
                  console.log(`    SAMPLE: ${JSON.stringify(body).slice(0, 1200)}`);
                }
              }
              break;
            }
          }
        } catch (err) {
          console.log(`  ${t.label.padEnd(20)} ${r.method.padEnd(6)} ${fullUrl} -> ERROR ${sanitise(String((err as Error).message), secrets).slice(0, 80)}`);
        }
        await page.waitForTimeout(800);
      }
    }

    console.log(`\n[6] navigate to a single data-pack detail page`);
    const oneDataPackLink = await page.locator("a[href^='/data-pack/']").first().getAttribute("href");
    if (oneDataPackLink) {
      const fullDp = `https://p1doks.com${oneDataPackLink}`;
      console.log(`  visiting ${fullDp}`);
      await page.goto(fullDp, { waitUntil: "networkidle", timeout: 30000 });
      await page.waitForTimeout(6000);

      const seen = new Set<string>(Array.from(seenUrls));
      const newOnes = intercepted.filter((r) => !seen.has(`${r.method} ${r.url}`));
      console.log(`\n[7] new api.p1doks.com calls during data-pack detail (${newOnes.length}):`);
      const dedup = new Set<string>();
      for (const r of newOnes) {
        const k = `${r.method} ${r.url}`;
        if (dedup.has(k)) continue;
        dedup.add(k);
        console.log(`  ${r.method.padEnd(6)} ${r.url}`);
        if (r.postData) console.log(`    postData: ${r.postData.slice(0, 400)}`);
      }
    } else {
      console.log("  no /data-pack/* link found on marketplace");
    }

    console.log(`\n[8] marketplace DOM evidence of lap times`);
    await page.goto("https://p1doks.com/marketplace", { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(6000);
    const cardSamples = await page.evaluate(() => {
      const out: { text: string; htmlLength: number }[] = [];
      document.querySelectorAll("article, [class*='card'], [class*='Card'], li").forEach((el) => {
        const text = (el as HTMLElement).innerText.replace(/\s+/g, " ").trim();
        if (text.length > 30 && text.length < 500 && /\d:\d\d/.test(text)) {
          out.push({ text, htmlLength: (el as HTMLElement).innerHTML.length });
        }
      });
      return out.slice(0, 10);
    });
    for (const c of cardSamples) {
      console.log(`  CARD-TEXT[${c.htmlLength}]: ${c.text}`);
    }
  } catch (err) {
    const msg = sanitise(String((err as Error).message || err), secrets);
    console.error(`probe step 2 failed: ${msg}`);
  } finally {
    await browser.close();
  }
}

main().catch(() => {
  console.error("probe step 2 crashed");
  process.exit(1);
});

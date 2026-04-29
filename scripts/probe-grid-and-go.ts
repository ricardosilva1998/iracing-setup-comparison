/**
 * Grid-and-Go auth probe (NOT a scraper).
 *
 * Goal: walk the login flow once with Playwright, capture *structural* facts
 * (URLs hit, cookies set, post-login routes, captcha/MFA presence), and exit.
 *
 * Hard rules:
 *   - Read creds from process.env. Never log them, never write them anywhere.
 *   - Print only structural / non-secret info: URLs (with sensitive query params
 *     stripped), HTTP statuses, cookie names (no values), DOM landmarks.
 *   - On error, sanitize messages so creds cannot leak via stack traces.
 *   - Run headless. Save NO traces / videos / screenshots that could embed
 *     form values.
 */
import "dotenv/config";
import { chromium } from "playwright";

function redact(value: string | undefined): string {
  if (!value) return "<missing>";
  return `<set length=${value.length}>`;
}

// Strip query params that may contain auth codes / tokens before logging URLs.
function safeUrl(u: string): string {
  try {
    const parsed = new URL(u);
    const stripParams = ["code", "code_challenge", "code_verifier", "state", "id_token", "access_token", "refresh_token", "session"];
    for (const p of stripParams) parsed.searchParams.delete(p);
    return parsed.origin + parsed.pathname + (parsed.search ? `?${parsed.searchParams.toString()}` : "");
  } catch {
    return "<unparseable url>";
  }
}

// Sanitise strings before logging — strip any occurrence of known secrets.
function sanitise(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s) out = out.split(s).join("<REDACTED>");
  }
  return out;
}

async function main() {
  const email = process.env.GRID_AND_GO_EMAIL;
  const password = process.env.GRID_AND_GO_PASSWORD;
  console.log(`creds: email=${redact(email)} password=${redact(password)}`);
  if (!email || !password) {
    console.error("missing GRID_AND_GO_EMAIL or GRID_AND_GO_PASSWORD in .env");
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

  // observation log -----------------------------------------------------
  const requests: { method: string; url: string; status?: number }[] = [];
  page.on("request", (req) => {
    requests.push({ method: req.method(), url: safeUrl(req.url()) });
  });
  page.on("response", async (res) => {
    const last = requests[requests.length - 1];
    if (last && last.url === safeUrl(res.url())) {
      last.status = res.status();
    }
  });

  try {
    console.log("\n[1] navigate to https://app.grid-and-go.com/");
    await page.goto("https://app.grid-and-go.com/", { waitUntil: "networkidle", timeout: 30000 });
    // Give the SPA up to 6s to render and decide whether to redirect.
    await page.waitForTimeout(6000);
    console.log(`  landed at: ${safeUrl(page.url())}`);

    // Detect captcha / MFA scaffolding before we ever type anything.
    const html = await page.content();
    const captchaHits = (html.match(/recaptcha|hcaptcha|turnstile|cf-challenge/gi) || []).length;
    const mfaHits = (html.match(/two[\s-]?factor|2fa|otp|verification code|authenticator/gi) || []).length;
    console.log(`  captcha markers in landing DOM: ${captchaHits}`);
    console.log(`  mfa markers in landing DOM: ${mfaHits}`);
    console.log(`  body text length after SPA render: ${html.length}`);

    // Dump every visible button + link text + href to find login affordance.
    const visibleText = await page.evaluate(() => {
      const out: string[] = [];
      document.querySelectorAll("a, button, [role='button']").forEach((el) => {
        const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
        const href = (el as HTMLAnchorElement).href || "";
        const onClick = (el as HTMLElement).onclick ? "[has onclick]" : "";
        if (txt && txt.length < 80) out.push(`${el.tagName}[${href.slice(0, 80)}]${onClick}: ${txt}`);
      });
      return out.slice(0, 100);
    });
    console.log(`  affordances on landing (with hrefs):`);
    for (const t of visibleText) console.log(`    ${t}`);

    // Scroll the page to ensure all elements render.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(1000);
    const afterScroll = await page.evaluate(() => {
      const out: string[] = [];
      document.querySelectorAll("a, button, [role='button']").forEach((el) => {
        const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
        const href = (el as HTMLAnchorElement).href || "";
        if (txt && txt.length < 80) out.push(`${el.tagName}[${href.slice(0, 80)}]: ${txt}`);
      });
      return out.slice(0, 100);
    });
    console.log(`  affordances after scroll:`);
    for (const t of afterScroll) console.log(`    ${t}`);

    // The SPA is at app.grid-and-go.com but the real login form is on
    // grid-and-go-auth.auth.eu-central-1.amazoncognito.com.
    const onCognito = page.url().includes("amazoncognito.com");
    console.log(`  redirected to Cognito hosted login: ${onCognito}`);

    if (!onCognito) {
      // Try clicking a login affordance (case-insensitive contains).
      const loginEl = page.locator(
        "a:has-text('Login'), a:has-text('Log in'), a:has-text('Sign in'), a:has-text('LOG IN'), a:has-text('SIGN IN'), button:has-text('Login'), button:has-text('Log in'), button:has-text('Sign in')",
      ).first();
      const visible = await loginEl.isVisible().catch(() => false);
      console.log(`  login affordance visible: ${visible}`);
      if (visible) {
        await loginEl.click();
        await page.waitForURL(/amazoncognito\.com|grid-and-go-auth/, { timeout: 15000 }).catch((e) => {
          console.log(`  did not navigate to cognito after click: ${sanitise(String(e), secrets).slice(0, 120)}`);
        });
        console.log(`  after login click -> ${safeUrl(page.url())}`);
      } else {
        // Body-text inspection has revealed a "SIGN IN or REGISTER" prompt
        // in the SPA's TopNav. Find any element whose textContent contains "SIGN IN".
        const signInLocations = await page.evaluate(() => {
          const out: { tag: string; text: string; cls: string; role: string }[] = [];
          document.querySelectorAll("*").forEach((el) => {
            const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
            // Don't match large containers that contain "SIGN IN" in their long text.
            if (/SIGN IN/i.test(txt) && txt.length < 80) {
              out.push({
                tag: el.tagName,
                text: txt,
                cls: (el as HTMLElement).className?.toString().slice(0, 60) || "",
                role: el.getAttribute("role") || "",
              });
            }
          });
          return out.slice(0, 20);
        });
        console.log(`  elements containing 'SIGN IN':`);
        for (const e of signInLocations) console.log(`    <${e.tag} class='${e.cls}' role='${e.role}'> ${e.text}`);

        // Click the smallest such element.
        const trigger = page.locator(":has-text('SIGN IN')").last();
        if (await trigger.count() > 0) {
          console.log(`  clicking SIGN IN trigger`);
          await trigger.click().catch((e) => console.log(`  click error: ${sanitise(String(e), secrets).slice(0, 80)}`));
          await page.waitForTimeout(8000);
          console.log(`  after click -> ${safeUrl(page.url())}`);
        }
      }
    }

    if (!page.url().includes("amazoncognito.com")) {
      console.log("  NOT on Cognito hosted login. Probe ends here.");
      return;
    }

    console.log("\n[2] inspect Cognito hosted login form");
    // Wait up to 8s for the form to settle.
    await page.waitForTimeout(4000);
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    const cognitoHtml = await page.content();
    const captchaHits2 = (cognitoHtml.match(/recaptcha|hcaptcha|turnstile|cf-challenge|g-recaptcha/gi) || []).length;
    // Filter MFA strings to only those in *visible* containers — Cognito hosted UI ships
    // copy for a forgot-password/MFA-recovery flow that's hidden until needed.
    const visibleMfa = await page.evaluate(() => {
      const out: string[] = [];
      document.querySelectorAll("*").forEach((el) => {
        const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
        const visible = (el as HTMLElement).offsetParent !== null;
        if (visible && /verification code|authenticator|sms code|enter the code|two[\s-]?factor/i.test(txt) && txt.length < 200) {
          out.push(txt);
        }
      });
      return Array.from(new Set(out)).slice(0, 5);
    });
    console.log(`  captcha markers on hosted login (HTML): ${captchaHits2}`);
    console.log(`  visible mfa-ish text:`);
    for (const t of visibleMfa) console.log(`    ${t.slice(0, 120)}`);

    // The Cognito hosted UI may have a "Sign In" tab that needs activating.
    const tabSignIn = page.locator("a:has-text('Sign In'), [role='tab']:has-text('Sign In'), button:has-text('Sign In')").first();
    if (await tabSignIn.count() > 0) {
      const visible = await tabSignIn.isVisible().catch(() => false);
      if (visible) {
        console.log("  activating Sign In tab");
        await tabSignIn.click().catch(() => {});
        await page.waitForTimeout(2000);
      }
    }

    // Cognito hosted UI renders the form twice (mobile + desktop variants).
    // The first input is hidden; the visible one is the second / last.
    const usernameSel = page.locator("input[name='username']:visible").first();
    const passwordSel = page.locator("input[name='password']:visible").first();
    const submitSel = page.locator("input[name='signInSubmitButton']:visible").first();

    await usernameSel.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
    const userVis = await usernameSel.isVisible().catch(() => false);
    const pwVis = await passwordSel.isVisible().catch(() => false);
    console.log(`  visible username field present: ${userVis}`);
    console.log(`  visible password field present: ${pwVis}`);

    console.log("\n[3] submit credentials");
    await usernameSel.fill(email);
    await passwordSel.fill(password);
    await submitSel.click();

    // Wait for either: redirect back to app, error message, or MFA prompt.
    try {
      await page.waitForURL(/app\.grid-and-go\.com/, { timeout: 20000 });
      console.log(`  post-login URL: ${safeUrl(page.url())}`);
    } catch {
      const stillOnCognito = page.url().includes("amazoncognito.com");
      const errEl = await page.locator(".error, [role='alert'], .errorMessage, .modal-error").first();
      const errText = (await errEl.textContent().catch(() => null)) || "";
      console.log(`  did NOT redirect back to app. still on Cognito: ${stillOnCognito}`);
      console.log(`  error region text: ${sanitise(errText.trim(), secrets) || "<empty>"}`);
      // capture mfa indicators if a challenge page rendered
      const after = await page.content();
      const mfaHits3 = (after.match(/verification code|authenticator|sms|enter code/gi) || []).length;
      console.log(`  mfa markers after submit: ${mfaHits3}`);
      return;
    }

    // We should be authenticated now.
    console.log("\n[4] post-login app inspection");
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    console.log(`  current URL: ${safeUrl(page.url())}`);

    const cookies = await context.cookies();
    console.log(`  cookie names: ${cookies.map((c) => c.name).sort().join(", ")}`);

    // Inspect the SPA's storage for tokens (we won't log values, only key presence).
    const storage = await page.evaluate(() => {
      const ls = Object.keys(localStorage);
      const ss = Object.keys(sessionStorage);
      return { localStorage: ls, sessionStorage: ss };
    });
    console.log(`  localStorage keys: ${storage.localStorage.join(", ")}`);
    console.log(`  sessionStorage keys: ${storage.sessionStorage.join(", ")}`);

    // What routes exist in the SPA?
    const links = await page.locator("a[href^='/']").evaluateAll((els) =>
      Array.from(new Set(els.map((e) => (e as HTMLAnchorElement).getAttribute("href")))).slice(0, 40),
    );
    console.log(`  internal links on landing app: ${links.join(", ")}`);

    // Headings to grok the IA.
    const headings = await page.locator("h1, h2, h3").evaluateAll((els) =>
      els.map((e) => (e.textContent || "").trim()).filter(Boolean).slice(0, 30),
    );
    console.log(`  headings: ${headings.join(" | ")}`);

    // Body landmarks.
    const navText = await page.locator("nav").first().textContent().catch(() => null);
    console.log(`  nav text (truncated): ${(navText || "").replace(/\s+/g, " ").trim().slice(0, 200)}`);

    console.log("\n[5] navigate hash routes for setups / library");
    const hashRoutes = ["#/datapacks", "#/profile"];
    for (const p of hashRoutes) {
      const url = `https://app.grid-and-go.com/${p}`;
      console.log(`  ${p}`);
      await page.goto(url, { waitUntil: "networkidle", timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(6000);
      const titleEls = await page.locator("h1, h2, h3").evaluateAll((els) =>
        els.map((e) => (e.textContent || "").trim()).filter(Boolean).slice(0, 8),
      );
      const cardCount = await page.locator("[class*='card'], article, li[class]").count();
      const summary = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 400));
      console.log(`    headings: ${titleEls.join(" / ")}, cardCount=${cardCount}`);
      console.log(`    body sample: ${summary}`);
    }

    console.log("\n[6] tail API requests (full last 60)");
    const apiCalls = requests.filter((r) => r.url.includes("execute-api"));
    for (const r of apiCalls.slice(-60)) {
      console.log(`  ${r.method.padEnd(6)} ${r.status ?? "---"} ${r.url}`);
    }

    console.log("\n[7] direct JSON probe of /datapacks");
    const idToken = await page.evaluate(() => localStorage.getItem("id_token"));
    if (!idToken) {
      console.log("  no id_token in localStorage — skipping direct probe");
    } else {
      console.log(`  id_token present: <set length=${idToken.length}>`);
      const probeYear = 2026;
      for (const season of [2]) {
        const r = await page.request.get(
          `https://oaseb2ya72.execute-api.eu-central-1.amazonaws.com/datapacks?year=${probeYear}&season=${season}`,
          { headers: { Authorization: `Bearer ${idToken}` } },
        );
        console.log(`  /datapacks?year=${probeYear}&season=${season} -> ${r.status()}`);
        const headers = r.headers();
        console.log(`    rate-limit headers: ${JSON.stringify(Object.fromEntries(Object.entries(headers).filter(([k]) => /rate|retry|throttl|x-amzn/i.test(k))))}`);
        if (r.ok()) {
          const body = await r.json().catch(() => null);
          if (body && typeof body === "object" && Array.isArray((body as { items?: unknown }).items)) {
            const items = (body as { items: Record<string, unknown>[] }).items;
            console.log(`    items.length=${items.length}`);
            // count distinct (car, track, week)
            const triples = new Set<string>();
            const weekCounts: Record<number, number> = {};
            const seriesCounts: Record<string, number> = {};
            const subsCounts: Record<string, number> = {};
            for (const it of items) {
              const w = it.week as number;
              triples.add(`${it.carName}|${it.trackName}|${w}`);
              weekCounts[w] = (weekCounts[w] || 0) + 1;
              const series = it.series as string;
              seriesCounts[series] = (seriesCounts[series] || 0) + 1;
              const subs = (it.subscriptions as string[] | undefined)?.join("+") || "none";
              subsCounts[subs] = (subsCounts[subs] || 0) + 1;
            }
            console.log(`    distinct (car|track|week): ${triples.size}`);
            console.log(`    per-week counts: ${JSON.stringify(weekCounts)}`);
            console.log(`    per-series counts: ${JSON.stringify(seriesCounts)}`);
            console.log(`    per-subscription counts: ${JSON.stringify(subsCounts)}`);
            // Sample items distinct by car+track for the first 5 weeks.
            const sample = items.slice(0, 3);
            for (const it of sample) {
              console.log(`    SAMPLE: ${JSON.stringify(it)}`);
            }
          }
        }
        await page.waitForTimeout(5000 + Math.random() * 2000);
      }

      // Probe a single datapack detail to see if there's per-pack richer data.
      console.log("  probing a datapack detail endpoint guess");
      const detailGuesses = ["/datapacks/6a7H46oDWT0t", "/datapack/6a7H46oDWT0t"];
      for (const g of detailGuesses) {
        const r = await page.request.get(
          `https://oaseb2ya72.execute-api.eu-central-1.amazonaws.com${g}`,
          { headers: { Authorization: `Bearer ${idToken}` } },
        );
        console.log(`    ${g} -> ${r.status()}`);
        if (r.ok()) {
          const body = await r.text();
          console.log(`      response (truncated): ${body.slice(0, 500)}`);
        }
        await page.waitForTimeout(5000 + Math.random() * 2000);
      }
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
  // do NOT print the error if it might contain creds
  process.exit(1);
});

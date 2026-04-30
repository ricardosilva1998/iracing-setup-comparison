/**
 * Grid-and-Go file-download surface probe.
 *
 * Goal: identify exactly how the GnG SPA fetches setup files when the user
 * clicks Download. Capture the endpoint URL, request shape, response shape
 * (signed S3 URL? direct stream? JSON manifest?), auth model, file count,
 * and file extensions.
 *
 * Hard rules (mirrors probe-p1doks-step2.ts):
 *   - Read creds from process.env. Never log values — only redacted lengths.
 *   - Authorization / Cookie header values masked to <bearer length=N>.
 *   - Run headless. NO recordVideo, NO recordHar, NO tracing.
 *   - sanitise() all error messages before printing.
 *   - URLs scrubbed via safeUrl() before logging.
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
      "code", "code_challenge", "code_verifier", "state",
      "id_token", "access_token", "refresh_token", "session",
      "X-Amz-Signature", "X-Amz-Credential", "X-Amz-Security-Token",
      "X-Amz-Date", "X-Amz-Expires", "token", "auth", "jwt",
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

/** Two real datapack IDs from local dev.db (Grid-and-Go SetupListings). */
const PROBE_DATAPACK_IDS = ["9qJ33t1m4pvw", "YSZHIhMbWY9i"];

async function main() {
  const email = process.env.GRID_AND_GO_EMAIL;
  const password = process.env.GRID_AND_GO_PASSWORD;
  console.log(`creds: email=${redact(email)} password=${redact(password)}`);
  if (!email || !password) {
    console.error("missing GRID_AND_GO_EMAIL or GRID_AND_GO_PASSWORD in .env");
    process.exit(1);
  }

  const secrets = [email, password];

  const chromiumPath = process.env.CHROMIUM_PATH;
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

  const page = await context.newPage();

  // ── Request/Response interceptor ──────────────────────────────────────────
  type InterceptEntry = {
    method: string;
    url: string;
    headerKeys: string[];
    authMasked: string | null;
    postDataSample: string | null;
    status?: number;
    contentType?: string;
    contentLength?: string;
    responseSample?: string;
  };
  const intercepted: InterceptEntry[] = [];

  page.on("request", (req) => {
    const url = req.url();
    if (
      url.includes("execute-api") ||
      url.includes("amazonaws.com") ||
      url.includes("grid-and-go") ||
      url.includes("download") ||
      url.includes(".sto") ||
      url.includes(".htm") ||
      url.includes(".zip") ||
      url.includes(".json")
    ) {
      const headers = req.headers();
      const authHeader = headers["authorization"] ?? headers["Authorization"];
      const authMasked = authHeader ? `<bearer length=${authHeader.length}>` : null;
      const postData = req.postData();
      const postSample = postData ? postData.slice(0, 200) : null;
      intercepted.push({
        method: req.method(),
        url: safeUrl(url),
        headerKeys: Object.keys(headers).filter(
          (k) => k.toLowerCase() !== "authorization" && k.toLowerCase() !== "cookie",
        ),
        authMasked,
        postDataSample: postSample,
      });
    }
  });

  page.on("response", async (res) => {
    const url = res.url();
    if (
      url.includes("execute-api") ||
      url.includes("amazonaws.com/") ||
      url.includes("download") ||
      url.includes(".sto") ||
      url.includes(".zip")
    ) {
      const headers = res.headers();
      const contentType = headers["content-type"] ?? null;
      const contentLength = headers["content-length"] ?? null;
      const entry = intercepted.find((e) => e.url === safeUrl(url));
      if (entry) {
        entry.status = res.status();
        entry.contentType = contentType ?? undefined;
        entry.contentLength = contentLength ?? undefined;
        try {
          const buffer = await res.body().catch(() => null);
          if (buffer) {
            const ct = contentType ?? "";
            if (ct.includes("text") || ct.includes("json") || ct.includes("html")) {
              entry.responseSample = buffer.toString("utf8").slice(0, 300);
            } else {
              entry.responseSample = `<binary: ${buffer.length} bytes; hex=${buffer.slice(0, 32).toString("hex")}>`;
            }
          }
        } catch {
          // ignore body-read errors on navigation requests
        }
      }
    }
  });

  try {
    // ── Step 1: Login ─────────────────────────────────────────────────────
    console.log("\n[1] navigate to https://app.grid-and-go.com/");
    await page.goto("https://app.grid-and-go.com/", { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(6000);

    console.log("triggering sign-in");
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
    console.log("post-login redirect ok");
    await page.waitForTimeout(5000);

    const idToken = await page.evaluate(() => localStorage.getItem("id_token"));
    if (!idToken) throw new Error("login succeeded but no id_token in localStorage");
    console.log(`authenticated. id_token length=${idToken.length}`);

    // ── Step 2: Navigate to each datapack detail page + click Download ─────
    for (const packId of PROBE_DATAPACK_IDS) {
      const url = `https://app.grid-and-go.com/#/datapacks/${packId}`;
      console.log(`\n[2] navigate to datapack ${packId}`);
      intercepted.length = 0; // reset per-datapack

      await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
      await page.waitForTimeout(6000);

      const pageTitle = await page
        .locator("h1, h2, .title, [class*='title']")
        .first()
        .textContent()
        .catch(() => null);
      console.log(`  page title: ${(pageTitle ?? "").replace(/\s+/g, " ").trim().slice(0, 120)}`);

      // Discover all Download-related affordances before clicking
      const affordances = await page.evaluate(() => {
        const out: { tag: string; text: string; href: string; cls: string }[] = [];
        document.querySelectorAll("a, button, [role='button'], [class*='download'], [class*='Download']").forEach((el) => {
          const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
          const href = (el as HTMLAnchorElement).href || "";
          const cls = (el as HTMLElement).className?.toString() || "";
          if (/download|setup|file|sto/i.test(txt + href + cls) || txt.length < 60) {
            out.push({ tag: el.tagName, text: txt.slice(0, 80), href: href.slice(0, 200), cls: cls.slice(0, 60) });
          }
        });
        return out.slice(0, 30);
      });
      console.log(`  affordances on detail page:`);
      for (const a of affordances) {
        console.log(`    <${a.tag}> "${a.text}" href="${a.href}" class="${a.cls}"`);
      }

      // Click Download
      const downloadBtn = page
        .locator("button:has-text('Download'), a:has-text('Download'), button:has-text('download')")
        .first();
      const btnVisible = await downloadBtn.isVisible().catch(() => false);
      console.log(`  Download button visible: ${btnVisible}`);

      if (btnVisible) {
        console.log("  clicking Download button...");
        await downloadBtn.click();
        await page.waitForTimeout(8000);
        await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      } else {
        const anyDownload = page.locator(":has-text('Download')").last();
        const anyVisible = await anyDownload.isVisible().catch(() => false);
        console.log(`  fallback :has-text('Download') visible: ${anyVisible}`);
        if (anyVisible) {
          await anyDownload.click();
          await page.waitForTimeout(8000);
          await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
        }
      }

      console.log(`  captured requests after Download click (${intercepted.length}):`);
      for (const entry of intercepted) {
        console.log(`    ${entry.method.padEnd(6)} ${entry.status ?? "---"} ${entry.url}`);
        if (entry.authMasked) console.log(`      auth: ${entry.authMasked}`);
        if (entry.postDataSample) console.log(`      postData: ${entry.postDataSample}`);
        if (entry.contentType) console.log(`      content-type: ${entry.contentType}`);
        if (entry.contentLength) console.log(`      content-length: ${entry.contentLength}`);
        if (entry.responseSample) console.log(`      response: ${entry.responseSample.slice(0, 300)}`);
      }

      // ── Step 3: Direct API probe with id_token ───────────────────────────
      console.log(`\n[3] direct API probe for ${packId}`);
      const apiHost = "https://oaseb2ya72.execute-api.eu-central-1.amazonaws.com";
      const endpoints = [
        `/datapacks/${packId}/download`,
        `/datapacks/${packId}/files`,
        `/datapacks/${packId}/file`,
        `/datapacks/${packId}`,
        `/download/${packId}`,
        `/files/${packId}`,
      ];

      for (const ep of endpoints) {
        const r = await page.request
          .get(`${apiHost}${ep}`, { headers: { Authorization: `Bearer ${idToken}` }, timeout: 20000 })
          .catch((e) => {
            console.log(`    GET ${ep} -> ERROR: ${sanitise(String(e), secrets).slice(0, 80)}`);
            return null;
          });
        if (!r) continue;
        const status = r.status();
        const ct = r.headers()["content-type"] ?? "";
        console.log(`    GET ${ep} -> ${status} (${ct})`);
        if (r.ok()) {
          const body = ct.includes("json")
            ? JSON.stringify(await r.json().catch(() => null)).slice(0, 500)
            : (await r.text().catch(() => "")).slice(0, 300);
          console.log(`      body: ${body}`);
        }
        await page.waitForTimeout(3000 + Math.random() * 1000);
      }

      // POST variant
      const rPost = await page.request
        .post(`${apiHost}/datapacks/${packId}/download`, {
          headers: { Authorization: `Bearer ${idToken}` },
          timeout: 20000,
        })
        .catch(() => null);
      if (rPost) {
        console.log(`    POST /datapacks/${packId}/download -> ${rPost.status()}`);
        if (rPost.ok())
          console.log(`      body: ${(await rPost.text().catch(() => "")).slice(0, 300)}`);
      }

      await page.waitForTimeout(5000 + Math.random() * 2000);
    }

    // ── Step 4: Probe /profile to understand subscription scope ───────────
    console.log("\n[4] GET /profile");
    const apiHost2 = "https://oaseb2ya72.execute-api.eu-central-1.amazonaws.com";
    const profileResp = await page.request
      .get(`${apiHost2}/profile`, { headers: { Authorization: `Bearer ${idToken!}` }, timeout: 15000 })
      .catch(() => null);
    if (profileResp) {
      console.log(`  GET /profile -> ${profileResp.status()}`);
      if (profileResp.ok()) {
        const body = await profileResp.json().catch(() => null);
        console.log(`  body keys: ${body ? Object.keys(body as object).join(", ") : "n/a"}`);
      }
    }
  } catch (err) {
    const msg = sanitise(String((err as Error).message ?? err), secrets);
    console.error(`\nprobe failed: ${msg}`);
  } finally {
    await browser.close();
  }
}

main().catch(() => {
  console.error("probe crashed");
  process.exit(1);
});

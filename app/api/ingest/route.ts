/**
 * POST /api/ingest -- bearer-protected scrape trigger for the production DB.
 *
 * Round 5: the standalone Next.js runner does not include scripts/ or tsx,
 * so we cannot run `npm run scrape:*` against the deployed container. This
 * route lets a cron caller (or a curl) trigger the same lib-level scrape
 * code path that the local CLI wrappers use.
 *
 * Auth model:
 *   - INGEST_SECRET is read from env. If missing, 500 (mis-configured).
 *   - Authorization: Bearer <token>. Compared with crypto.timingSafeEqual
 *     after length-equalisation so we don't leak missing-vs-wrong via timing
 *     OR via crypto.timingSafeEqual's length-mismatch synchronous throw.
 *   - On any auth failure: 401 with a generic body. No discrimination.
 *
 * Query string:
 *   ?shop=hymo            -> run HYMO only
 *   ?shop=grid-and-go     -> run GnG only (requires playwright + Chromium)
 *   ?shop=all (default)   -> run HYMO, then GnG; GnG failure does not
 *                            invalidate HYMO success
 *
 * Response shape (200):
 *   { ok, shop, durationMs, hymo?: {...}, gridAndGo?: {...} }
 * Response shape (401, 405, 500):
 *   { error: <generic message> }
 *
 * Errors are sanitised (no stack trace, no env leakage; secrets stripped via
 * sanitise()).
 */
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { prisma } from "@/lib/db";
import { runHymoScrape } from "@/lib/scrape/hymo";
import { runGridAndGoScrape, sanitise } from "@/lib/scrape/grid-and-go";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // seconds; covers Cognito auth + scrape

type ShopFilter = "hymo" | "grid-and-go" | "all";

const VALID_SHOPS: ReadonlyArray<ShopFilter> = ["hymo", "grid-and-go", "all"];

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

/**
 * Constant-time bearer-token check. Length-equalises both sides so
 * timingSafeEqual never throws on length mismatch and so the comparison
 * stays constant time past the length check.
 */
function checkBearer(authHeader: string | null, expected: string): boolean {
  if (!authHeader) return false;
  // Accept only a strictly-formed "Bearer <token>" with single space; reject
  // case variants of the scheme to avoid implementations that lower-case it.
  const m = /^Bearer (.+)$/.exec(authHeader);
  if (!m) return false;
  const presented = m[1];

  const expectedBuf = Buffer.from(expected, "utf8");
  const presentedBuf = Buffer.from(presented, "utf8");
  if (presentedBuf.length !== expectedBuf.length) {
    // Still do a constant-time op against expectedBuf to keep timing flat.
    const filler = Buffer.alloc(expectedBuf.length, 0);
    timingSafeEqual(filler, expectedBuf);
    return false;
  }
  return timingSafeEqual(presentedBuf, expectedBuf);
}

function parseShopParam(req: NextRequest): ShopFilter {
  const raw = req.nextUrl.searchParams.get("shop");
  if (!raw) return "all";
  const lower = raw.toLowerCase();
  if ((VALID_SHOPS as readonly string[]).includes(lower)) {
    return lower as ShopFilter;
  }
  return "all";
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now();

  // 1. Misconfiguration -> 500 BEFORE inspecting the auth header so that we
  //    don't accidentally let a request through if the env var is missing
  //    and the empty string happens to match.
  const expected = process.env.INGEST_SECRET;
  if (!expected || expected.length < 16) {
    console.error("[ingest] INGEST_SECRET not configured");
    return NextResponse.json(
      { error: "Server misconfigured" },
      { status: 500 },
    );
  }

  // 2. Bearer check (constant-time).
  const authHeader = request.headers.get("authorization");
  if (!checkBearer(authHeader, expected)) {
    return unauthorized();
  }

  // 3. Determine which shops to run.
  const shop = parseShopParam(request);

  // 4. Read sanitisation seeds from env so any leaked stack message is
  //    scrubbed of credentials before being returned to the caller.
  const secrets = [
    process.env.GRID_AND_GO_EMAIL,
    process.env.GRID_AND_GO_PASSWORD,
    expected,
  ].filter((s): s is string => !!s);

  type ScrapeOutcome =
    | { fetched: number; inserted: number; updated: number; errors: number }
    | { skipped: string };
  const result: {
    ok: boolean;
    shop: ShopFilter;
    durationMs: number;
    hymo?: ScrapeOutcome;
    gridAndGo?: ScrapeOutcome;
  } = {
    ok: true,
    shop,
    durationMs: 0,
  };

  try {
    if (shop === "hymo" || shop === "all") {
      try {
        const r = await runHymoScrape(prisma);
        result.hymo = {
          fetched: r.fetched,
          inserted: r.inserted,
          updated: r.updated,
          errors: r.errors.length,
        };
      } catch (err) {
        const msg = sanitise(String((err as Error).message || err), secrets);
        console.error(`[ingest] hymo failed: ${msg}`);
        result.hymo = { skipped: `hymo failed: ${msg.slice(0, 200)}` };
        result.ok = false;
      }
    }

    if (shop === "grid-and-go" || shop === "all") {
      try {
        const r = await runGridAndGoScrape(prisma);
        result.gridAndGo = {
          fetched: r.fetched,
          inserted: r.inserted,
          updated: r.updated,
          errors: r.errors.length,
        };
      } catch (err) {
        const msg = sanitise(String((err as Error).message || err), secrets);
        console.error(`[ingest] grid-and-go failed: ${msg}`);
        result.gridAndGo = { skipped: `grid-and-go failed: ${msg.slice(0, 200)}` };
        // shop=all keeps ok if at least HYMO succeeded; shop=grid-and-go
        // forces ok=false because the only requested shop failed.
        if (shop === "grid-and-go") result.ok = false;
      }
    }

    result.durationMs = Date.now() - startedAt;
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    const msg = sanitise(String((err as Error).message || err), secrets);
    console.error(`[ingest] unhandled: ${msg}`);
    return NextResponse.json(
      { error: "Ingestion failed" },
      { status: 500 },
    );
  }
}

export async function GET() {
  return NextResponse.json(
    {
      error: "Method Not Allowed",
      hint: "POST /api/ingest with `Authorization: Bearer <INGEST_SECRET>` and optional ?shop=hymo|grid-and-go|all",
    },
    {
      status: 405,
      headers: { Allow: "POST" },
    },
  );
}

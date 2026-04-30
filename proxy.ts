/**
 * Next 16 middleware — guards the /admin path tree with HTTP Basic Auth.
 *
 * Runs in the Edge runtime. Does NOT gate /api/ingest (that endpoint has its
 * own bearer-token auth and is hit by the GitHub Actions cron on its own
 * schedule). Does NOT gate /, /compare, /week, or any other public route.
 *
 * Auth model:
 *   - ADMIN_USER + ADMIN_PASSWORD read from env.
 *   - If either is missing/empty OR ADMIN_PASSWORD is < 12 chars: 503
 *     (misconfigured; browser would not show a credential prompt for 503).
 *   - If present: expect Authorization: Basic <base64(user:password)>.
 *   - Missing or wrong scheme → 401 + WWW-Authenticate (browser prompts natively).
 *   - Wrong credentials → 401 generic. No discrimination of missing-vs-wrong.
 *   - Correct credentials → NextResponse.next().
 *
 * Constant-time compare strategy (Edge-safe, no Node Buffer):
 *   TextEncoder → Uint8Array XOR loop that always iterates expected.length times.
 *   Length-equalise BEFORE the loop so timing stays flat w.r.t. secret length.
 *   crypto.subtle.timingSafeEqual is not available in the Next Edge runtime;
 *   the manual XOR accumulator is the standard substitute.
 */
import { NextRequest, NextResponse } from "next/server";

export const config = {
  // /admin/:path*   — admin dashboard (existing)
  // /api/files/:path* — GnG setup file proxy (round 21)
  // /api/ingest is intentionally excluded: it has its own bearer-token auth
  // and is hit by the GitHub Actions cron directly.
  matcher: ["/admin/:path*", "/api/files/:path*"],
};

const REALM = "iRacing Setup Admin";
const MIN_PASSWORD_LEN = 12;

/**
 * Constant-time byte comparison without Node crypto or crypto.subtle.
 * Always iterates `expected.length` iterations. Returns true iff every byte
 * of `presented` (after length-equalisation) equals every byte of `expected`.
 */
function timingSafeCompare(presented: Uint8Array, expected: Uint8Array): boolean {
  // Non-zero if lengths differ — already encodes the mismatch in diff.
  let diff = presented.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) {
    // ?? 0: if presented is shorter, treat missing bytes as 0.
    diff |= (presented[i] ?? 0) ^ expected[i];
  }
  return diff === 0;
}

function unauthorized(): NextResponse {
  return NextResponse.json(
    { error: "Unauthorized" },
    {
      status: 401,
      headers: { "WWW-Authenticate": `Basic realm="${REALM}"` },
    },
  );
}

export function proxy(request: NextRequest): NextResponse {
  const adminUser = process.env.ADMIN_USER;
  const adminPassword = process.env.ADMIN_PASSWORD;

  // Guard against missing or too-short password before touching the auth header.
  if (!adminUser || !adminPassword || adminPassword.length < MIN_PASSWORD_LEN) {
    console.error("[admin] ADMIN_USER or ADMIN_PASSWORD not configured");
    return NextResponse.json(
      { error: "Admin not configured" },
      {
        status: 503,
        headers: { "Retry-After": "60" },
      },
    );
  }

  const authHeader = request.headers.get("authorization");

  if (!authHeader) return unauthorized();
  // Require exactly "Basic <base64>"; case-sensitive scheme.
  const m = /^Basic (.+)$/.exec(authHeader);
  if (!m) return unauthorized();

  // Base64-decode using the Edge-native globalThis.atob.
  let decoded: string;
  try {
    decoded = globalThis.atob(m[1]);
  } catch {
    return unauthorized();
  }

  // Split on the FIRST colon only — passwords may contain colons.
  const colonIdx = decoded.indexOf(":");
  if (colonIdx === -1) return unauthorized();
  const presentedUser = decoded.slice(0, colonIdx);
  const presentedPass = decoded.slice(colonIdx + 1);

  const enc = new TextEncoder();
  const expectedUserBytes = enc.encode(adminUser);
  const expectedPassBytes = enc.encode(adminPassword);
  const presentedUserBytes = enc.encode(presentedUser);
  const presentedPassBytes = enc.encode(presentedPass);

  // Both comparisons run unconditionally so timing does not reveal which field failed.
  const userOk = timingSafeCompare(presentedUserBytes, expectedUserBytes);
  const passOk = timingSafeCompare(presentedPassBytes, expectedPassBytes);

  if (!userOk || !passOk) return unauthorized();

  return NextResponse.next();
}

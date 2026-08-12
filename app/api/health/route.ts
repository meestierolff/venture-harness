import { NextRequest, NextResponse } from "next/server";
import { createHmac } from "node:crypto";

export const dynamic = "force-dynamic";

/**
 * Process-ownership probe for local production verification only.
 *
 * A normal deployment does not receive VH_LOCAL_SERVER_NONCE, so this route is
 * deliberately unavailable there. Local runners generate a fresh nonce for
 * the exact child process they spawn. The request carries only a public random
 * challenge; the expected process proves possession of its nonce with HMAC. A
 * stale reflector on a recycled port therefore cannot impersonate it.
 */
export function GET(request: NextRequest) {
  const expected = process.env.VH_LOCAL_SERVER_NONCE;
  const challenge = request.headers.get("x-vh-local-server-challenge");
  if (!expected || !challenge || !/^[a-f0-9]{48}$/u.test(challenge)) {
    return NextResponse.json(
      { ready: false },
      { status: 404, headers: { "cache-control": "no-store" } },
    );
  }
  const proof = createHmac("sha256", expected).update(challenge).digest("hex");
  return NextResponse.json({ ready: true, proof }, { headers: { "cache-control": "no-store" } });
}

/**
 * Anonymous first-party visitor id — the join key for Layer 3 evidence.
 * Contains no personal data and is never sent to third parties as an id.
 */
import { isVisitorId } from "./visitor-id";

const COOKIE = "vh_vid";

export function getVisitorId(): string {
  if (typeof document === "undefined") return "server";
  const match = document.cookie.match(new RegExp(`(?:^|; )${COOKIE}=([a-z0-9-]+)`));
  if (match && isVisitorId(match[1]!)) return match[1]!;
  const id = crypto.randomUUID();
  // First-party, one year, Lax — no cross-site use. Development over plain
  // HTTP cannot set a Secure cookie; every HTTPS surface can and must.
  const secure = document.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${COOKIE}=${id}; Max-Age=31536000; Path=/; SameSite=Lax${secure}`;
  return id;
}

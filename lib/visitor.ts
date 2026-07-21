/**
 * Anonymous first-party visitor id — the join key for Layer 3 evidence.
 * Contains no personal data and is never sent to third parties as an id.
 */
const COOKIE = "vh_vid";

export function getVisitorId(): string {
  if (typeof document === "undefined") return "server";
  const match = document.cookie.match(new RegExp(`(?:^|; )${COOKIE}=([a-z0-9-]+)`));
  if (match) return match[1];
  const id = crypto.randomUUID();
  // First-party, one year, Lax — no cross-site use.
  document.cookie = `${COOKIE}=${id}; Max-Age=31536000; Path=/; SameSite=Lax`;
  return id;
}

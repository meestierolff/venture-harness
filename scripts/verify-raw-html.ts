/**
 * Raw crawler verification against a RUNNING site (build + start, or a
 * deployed URL). Fetches key routes with three user agents (normal
 * browser, Googlebot-like, bingbot-like) and asserts the raw HTML —
 * before any JavaScript — contains: title, canonical, H1, core content,
 * internal links, structured data, and price text on pricing routes.
 *
 *   pnpm verify:raw-html                       # http://localhost:3000
 *   pnpm verify:raw-html -- --url https://example.com
 *
 * Exits 2 with instructions when no server is reachable (so callers can
 * distinguish "failed" from "could not run").
 */
import { Reporter } from "./lib/util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const urlFlag = process.argv.indexOf("--url");
const BASE = urlFlag !== -1 ? process.argv[urlFlag + 1] : "http://localhost:3000";

const USER_AGENTS: Record<string, string> = {
  browser:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  "googlebot-like": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  "bingbot-like": "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
};

const ROUTES: { path: string; expectPrice: boolean }[] = [
  { path: "/", expectPrice: false },
  { path: "/pricing", expectPrice: true },
];

/** Semantic core-content check: require a server-rendered main region with a
 * real content element. It deliberately avoids a word-count threshold; a
 * concise product can be complete and a long page can still be empty filler. */
export function hasServerRenderedCoreContent(html: string): boolean {
  const main = html.match(/<main(?:\s[^>]*)?>([\s\S]*?)<\/main>/i)?.[1];
  if (!main) return false;
  const withoutNonContent = main
    .replace(/<(script|style|template)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--([\s\S]*?)-->/g, " ");
  return [
    ...withoutNonContent.matchAll(
      /<(p|section|article|ul|ol|dl|table|form)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi,
    ),
  ].some((match) => /[\p{L}\p{N}]/u.test(match[2].replace(/<[^>]+>/g, " ")));
}

async function main() {
  const r = new Reporter(`verify-raw-html (${BASE})`);
  // Reachability probe first.
  try {
    await fetch(BASE, { redirect: "follow" });
  } catch {
    console.log(`SKIP verify-raw-html: no server reachable at ${BASE}`);
    console.log("→ run: pnpm build && pnpm start   (then rerun)  — or pass --url <deployed site>");
    process.exit(2);
  }

  for (const route of ROUTES) {
    for (const [uaName, ua] of Object.entries(USER_AGENTS)) {
      const label = `${route.path} [${uaName}]`;
      let html: string;
      try {
        const res = await fetch(`${BASE}${route.path}`, { headers: { "user-agent": ua } });
        if (!res.ok) {
          r.fail(label, `HTTP ${res.status}`, "fix the route or the server");
          continue;
        }
        html = await res.text();
      } catch (e) {
        r.fail(label, `fetch failed: ${String(e)}`, "check the server logs");
        continue;
      }
      const checks: [string, boolean, string][] = [
        ["title", /<title>[^<]{3,}<\/title>/.test(html), "add a real <title>"],
        ["canonical", /<link[^>]+rel="canonical"/.test(html), "emit metadata.alternates.canonical"],
        ["h1", /<h1[\s>]/.test(html), "server-render exactly one H1"],
        [
          "core content",
          hasServerRenderedCoreContent(html),
          "server-render a semantic <main> with a real content element",
        ],
        ["internal links", /<a[^>]+href="\//.test(html), "server-render internal links"],
        ["structured data", /application\/ld\+json/.test(html), "render <StructuredData> JSON-LD"],
      ];
      if (route.expectPrice) {
        checks.push([
          "price text",
          /(€|EUR|\$|USD|£|GBP)\s?\d|price/i.test(html.replace(/<[^>]+>/g, " ")),
          "render plain-HTML price facts on pricing routes",
        ]);
      }
      const failed = checks.filter(([, okFlag]) => !okFlag);
      if (failed.length === 0) r.ok(label);
      else
        for (const [what, , next] of failed)
          r.fail(`${label} ${what}`, "missing in raw HTML", next);
    }
  }
  r.finish();
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entry) void main();

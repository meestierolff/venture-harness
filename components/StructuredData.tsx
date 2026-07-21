/**
 * JSON-LD structured data, server-rendered so crawlers and answer engines
 * see it in raw HTML. Content must describe reality — structured-data
 * claims follow PRODUCT_TRUTH.md like any other public claim.
 */
/**
 * Safety constraint: `data` must be repo-authored (server code / config),
 * never user-generated content. JSON.stringify plus escaping every "<"
 * to its unicode form prevents script-tag breakout for that trusted input.
 */
export function StructuredData({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, "\\u003c") }}
    />
  );
}

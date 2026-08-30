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
export function StructuredData({
  data,
  claimIds = [],
}: {
  data: Record<string, unknown>;
  claimIds?: readonly string[];
}) {
  if (claimIds.some((id) => !/^truth-\d+$/u.test(id))) {
    throw new Error("Structured-data claim ids must reference Product Truth rows");
  }
  return (
    <script
      type="application/ld+json"
      data-claims={claimIds.join(" ") || undefined}
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, "\\u003c") }}
    />
  );
}

/**
 * Visible label for sample data, illustrative interfaces, prototypes, and
 * planned functionality. The hard rule "label samples and prototypes" is a
 * rendered element, not a comment.
 */
export function SampleLabel({
  kind = "sample",
}: {
  kind?: "sample" | "illustrative" | "prototype" | "planned" | "concierge";
}) {
  const text: Record<string, string> = {
    sample: "Sample data — not live customer data",
    illustrative: "Illustrative interface — not the live product",
    prototype: "Prototype — capabilities under development",
    planned: "Planned — not available yet",
    concierge: "Delivered by our team (human service)",
  };
  return <mark className="sample-label">{text[kind]}</mark>;
}

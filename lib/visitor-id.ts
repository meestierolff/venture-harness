/** Anonymous first-party identifier shape accepted at public evidence boundaries. */
export const VISITOR_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function isVisitorId(value: string): boolean {
  return VISITOR_ID_PATTERN.test(value);
}

/** The Policy tab, opened at a line of the root or of an included battery's file. */
export function policyLineHref(ref: {
  entry: string | null;
  line: number | null;
}): string {
  const query = new URLSearchParams({
    ...(ref.entry ? { entry: ref.entry } : {}),
    ...(ref.line ? { line: String(ref.line) } : {}),
  }).toString();
  return query ? `/openappa/policy?${query}` : "/openappa/policy";
}

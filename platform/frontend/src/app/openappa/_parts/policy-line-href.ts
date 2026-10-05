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

/** `appa.toml:6` for the root, `archestra/appa.toml:299` for a battery's file. */
export function policyLineLabel(ref: {
  entry: string | null;
  line: number | null;
}): string {
  const file = ref.entry
    ? ref.entry.replace(/^batteries\//, "").replace(/@sha256-[^/]+/, "")
    : "appa.toml";
  return ref.line ? `${file}:${ref.line}` : file;
}

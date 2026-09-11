type LegacyA2aAgentsSearchParams = Record<
  string,
  string | string[] | undefined
>;

const LEGACY_PARAMS = [
  "name",
  "scope",
  "teamIds",
  "authorIds",
  "excludeAuthorIds",
  "sortBy",
  "sortDirection",
  "page",
  "pageSize",
] as const;

export function getLegacyA2aAgentsRedirect(
  searchParams: LegacyA2aAgentsSearchParams,
) {
  const nextParams = new URLSearchParams();

  for (const key of LEGACY_PARAMS) {
    const value = searchParams[key];
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined) nextParams.append(key, item);
    }
  }

  const query = nextParams.toString();
  return `/agents${query ? `?${query}` : ""}`;
}

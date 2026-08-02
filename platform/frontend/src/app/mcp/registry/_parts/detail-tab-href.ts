/**
 * Builds the href for one tab on the MCP server detail page.
 *
 * The tab bar renders links, so the URL is the only source of truth for the
 * selected tab. Two rules make that work:
 *
 * - The rest of the query string is preserved, so `?server=` survives a move
 *   within the logs family and is dropped on the way out — a stale install
 *   selection must not linger on Overview or Credentials.
 * - Overview carries no `tab` param, matching the bare URL people land on.
 *
 * Preserving the other params also keeps each href an exact match for the URL
 * it selects. `PageLayout` compares hrefs against the full current URL and
 * falls back to a substring test when nothing matches exactly — under that
 * fallback a bare Overview href is a prefix of every other tab's URL, so
 * Overview would light up alongside whichever tab is really open.
 */
export function buildDetailTabHref({
  tab,
  pathname,
  searchParams,
}: {
  tab: string;
  pathname: string;
  searchParams: URLSearchParams;
}): string {
  const params = new URLSearchParams(searchParams.toString());

  if (tab === "overview") {
    params.delete("tab");
  } else {
    params.set("tab", tab);
  }

  if (!isLogsFamilyTab(tab)) {
    params.delete("server");
  }

  const queryString = params.toString();
  return queryString ? `${pathname}?${queryString}` : pathname;
}

/** The tabs that share one mounted logs view, and so share its `?server=`. */
function isLogsFamilyTab(tab: string): boolean {
  return tab === "logs" || tab === "inspector" || tab === "shell";
}

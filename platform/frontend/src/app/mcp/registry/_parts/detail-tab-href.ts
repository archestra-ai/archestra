/**
 * Builds the href for one secondary tab on the MCP server detail page.
 *
 * The tab bar renders links, so the URL is the only source of truth for the
 * selected tab. Two rules make that work:
 *
 * - The rest of the query string is preserved, so `?server=` survives a move
 *   within the logs family and is dropped on the way out — a stale install
 *   selection must not linger on the unified main page.
 * - Overview is the main page and carries no `tab` param.
 *
 * Preserving the other params also keeps each href an exact match for the URL
 * it selects. `PageLayout` compares hrefs against the full current URL and
 * falls back to a substring test when nothing matches exactly — under that
 * fallback a bare main-page href is a prefix of every tab's URL.
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

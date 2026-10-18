/**
 * Pages whose full page loads render their first rows on the server. For a
 * document of one of these, the proxy marks the request and the root layout
 * resolves the signed-in shell (session, bootstrap, issue index) on the
 * server, so the page's gates pass there and its content reaches the HTML.
 * Opting a page in is adding its path here; the page itself still seeds its
 * own data (see the registry's `prefetch-first-page.ts`).
 */
export const SHELL_SEED_ROUTES: readonly string[] = ["/mcp/registry"];

/** Whether a page path renders its first rows on the server. */
export function isShellSeedRoute(pathname: string | null | undefined): boolean {
  return !!pathname && SHELL_SEED_ROUTES.includes(pathname);
}

/**
 * The request header the proxy sets on such a document load, holding the
 * page's path. Always set or removed by the proxy, never trusted from the
 * client.
 */
export const SHELL_SEED_HEADER = "x-archestra-shell-seed";

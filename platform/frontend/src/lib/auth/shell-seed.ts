/**
 * Pages whose full page loads render their first screen on the server. For a
 * document of one of these, the proxy marks the request and the root layout
 * resolves the signed-in shell (session, bootstrap, banner, sidebar) on the
 * server, so the page's gates pass there and its content reaches the HTML.
 * Opting a page in is adding its path here; the page itself still seeds its
 * own data (see the registry's `prefetch-first-page.ts`).
 *
 * `/chat` is the new-chat screen. `/chat/new` is not here: it only redirects
 * to `/chat` in the browser.
 */
export const SHELL_SEED_ROUTES: readonly string[] = ["/mcp/registry", "/chat"];

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

/**
 * The query string of the marked document, set and removed with
 * {@link SHELL_SEED_HEADER}. The new-chat screen seeds its composer only when
 * the URL does not choose the agent itself (see `seedsNewChatComposer`).
 */
export const SHELL_SEED_SEARCH_HEADER = "x-archestra-shell-seed-search";

/**
 * Whether a `/chat` document's composer can be seeded on the server. The
 * server resolves the starting agent from the member's and the organization's
 * defaults; a URL that names an agent or a project leaves that choice to the
 * browser, which loads the composer's data itself.
 */
export function seedsNewChatComposer(search: string | null): boolean {
  const params = new URLSearchParams(search ?? "");
  return !params.has("agentId") && !params.has("project");
}

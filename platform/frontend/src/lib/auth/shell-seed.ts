/**
 * Pages whose full page loads render their first screen on the server. For a
 * document of one of these, the proxy marks the request and the root layout
 * resolves the signed-in shell (session, bootstrap, banner, sidebar) on the
 * server, so the page's gates pass there and its content reaches the HTML.
 * Opting a page in is adding its path here; the page itself still seeds its
 * own data (see the registry's `prefetch-first-page.ts`).
 *
 * `/chat` is the new-chat screen. `/chat/new` is not here: it only redirects
 * to `/chat` in the browser. Existing conversations (`/chat/<id>`) are matched
 * by `seededConversationId`.
 */
export const SHELL_SEED_ROUTES: readonly string[] = ["/mcp/registry", "/chat"];

/**
 * Whether a page renders its first rows on the server. `search` is the
 * document's query string: the connection approval page (`/connection` with a
 * `connectRequest`) is seeded, the plain Connect page is not.
 */
export function isShellSeedRoute(
  pathname: string | null | undefined,
  search: string | null = null,
): boolean {
  return (
    !!pathname &&
    (SHELL_SEED_ROUTES.includes(pathname) ||
      seededConversationId(pathname) !== null ||
      seededRunId(pathname) !== null ||
      seededConnectRequest(pathname, search) !== null)
  );
}

/**
 * The installer's connection request a `/connection` document approves, or
 * null. Its document is seeded with the shell and everything the approval
 * page reads before it can show its final state (see `prefetchShellSeed`).
 */
export function seededConnectRequest(
  pathname: string | null | undefined,
  search: string | null,
): string | null {
  if (pathname !== "/connection") return null;
  const id = new URLSearchParams(search ?? "").get("connectRequest");
  return id && CONNECT_REQUEST_ID.test(id) ? id : null;
}

/**
 * The conversation an existing-chat path (`/chat/<id>`) opens, or null. Its
 * document is seeded too: the shell, the end of the conversation and the
 * composer's agent (see `prefetchShellSeed`). Other `/chat/...` pages
 * (`/chat/new`, `/chat/runs/<id>`) are not conversations.
 */
export function seededConversationId(
  pathname: string | null | undefined,
): string | null {
  return CONVERSATION_PATH.exec(pathname ?? "")?.[1] ?? null;
}

/**
 * The run an Agent Runtime run path (`/chat/runs/<id>`) opens, or null. Its
 * document is seeded with the shell and the run's details, so an ended run
 * renders its page, and its output panel loading, before the history streams.
 */
export function seededRunId(
  pathname: string | null | undefined,
): string | null {
  return RUN_PATH.exec(pathname ?? "")?.[1] ?? null;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CONVERSATION_PATH = new RegExp(`^/chat/(${UUID})$`, "i");
const RUN_PATH = new RegExp(`^/chat/runs/(${UUID})$`, "i");
/** The random request id `POST /api/client-connections` returns (24 bytes, hex). */
const CONNECT_REQUEST_ID = /^[a-f0-9]{48}$/;

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

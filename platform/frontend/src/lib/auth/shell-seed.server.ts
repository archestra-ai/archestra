import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { headers } from "next/headers";
import { appsQueryKey, SIDEBAR_PINNED_APPS_QUERY } from "@/lib/app.query";
import { authQueryKeys } from "@/lib/auth/auth.query";
import {
  isShellSeedRoute,
  SHELL_SEED_HEADER,
  SHELL_SEED_SEARCH_HEADER,
  seedsNewChatComposer,
} from "@/lib/auth/shell-seed";
import {
  conversationsQueryKey,
  SIDEBAR_CONVERSATION_LIMIT,
} from "@/lib/chat/conversations-query-key";
import { newChatSeedQueries } from "@/lib/chat/new-chat-seed";
import { getBackendBaseUrl } from "@/lib/config/config";
import { environmentKeys } from "@/lib/environment.query";
import { mcpRegistryIssueIndexQueryKey } from "@/lib/mcp/mcp-registry.query";
import {
  projectListQueryKey,
  SIDEBAR_PINNED_PROJECTS_QUERY,
} from "@/lib/projects/projects.query";
import { siteNotificationKeys } from "@/lib/site-notification.query";
import { getServerApiHeaders } from "@/lib/utils/server";
import { withServerSeedDeadline } from "@/lib/utils/server-seed-timeout";

/**
 * What the signed-in shell waits on before it renders a page: the session and
 * the bootstrap (permissions, scoped capabilities, config, organization).
 */
export type ShellSeed = {
  session: { user: unknown; session: Record<string, unknown> };
  bootstrap: archestraApiTypes.GetBootstrapResponses["200"];
  /**
   * Other shell data the page's first render shows: the site notification,
   * the sidebar's conversations, pinned projects and pinned apps, its
   * warnings, and on the registry the issue index its badge reads.
   */
  queries: Array<{ queryKey: readonly unknown[]; data: unknown }>;
};

/**
 * The shell's session and bootstrap, resolved on the server for the documents
 * the proxy marks (pages whose first rows are server-rendered), so the auth
 * and permission gates let that page render into the HTML. Null otherwise,
 * and for a visitor who is not signed in or any failure: the shell then
 * resolves in the browser exactly as before. The session keeps only the
 * fields the app reads: the token never lands in the HTML.
 */
export async function prefetchShellSeed(): Promise<ShellSeed | null> {
  const requestHeaders = await headers();
  const route = requestHeaders.get(SHELL_SEED_HEADER);
  if (!isShellSeedRoute(route)) return null;
  const search = requestHeaders.get(SHELL_SEED_SEARCH_HEADER);
  try {
    const apiHeaders = await getServerApiHeaders();
    const [session, bootstrap, queries] = await withServerSeedDeadline(
      (signal) =>
        Promise.all([
          fetch(`${getBackendBaseUrl()}/api/auth/get-session`, {
            headers: apiHeaders,
            cache: "no-store",
            signal,
          }).then((response) =>
            response.ok
              ? (response.json() as Promise<ShellSeed["session"] | null>)
              : null,
          ),
          archestraApiSdk.getBootstrap({ headers: apiHeaders, signal }),
          readShellQueries({ route, search, headers: apiHeaders, signal }),
        ]),
    );
    if (!bootstrap.data) return null;
    if (!session?.user || !session.session) return null;
    return {
      session: { ...session, session: pickSeedSessionFields(session.session) },
      bootstrap: bootstrap.data,
      queries,
    };
  } catch {
    return null;
  }
}

// ===

/**
 * The reads whose data the first render shows, each under the key its query
 * uses.
 * A read the viewer may not make (a 403) or that fails is left out, and its
 * query loads in the browser as before.
 */
async function readShellQueries(params: {
  route: string | null;
  search: string | null;
  headers: Record<string, string>;
  signal: AbortSignal;
}): Promise<ShellSeed["queries"]> {
  const options = { headers: params.headers, signal: params.signal };
  const reads: Array<
    Promise<{ queryKey: readonly unknown[]; data: unknown } | null>
  > = [
    seedRead(
      siteNotificationKeys.active(),
      archestraApiSdk.getSiteNotification(options),
    ),
    seedRead(
      conversationsQueryKey(),
      archestraApiSdk.getChatConversations({
        ...options,
        query: { includeArtifacts: false, limit: SIDEBAR_CONVERSATION_LIMIT },
      }),
    ),
    seedRead(
      projectListQueryKey(SIDEBAR_PINNED_PROJECTS_QUERY),
      archestraApiSdk.getProjects({
        ...options,
        query: SIDEBAR_PINNED_PROJECTS_QUERY,
      }),
    ),
    seedRead(
      appsQueryKey(SIDEBAR_PINNED_APPS_QUERY),
      archestraApiSdk.getApps({ ...options, query: SIDEBAR_PINNED_APPS_QUERY }),
    ),
    seedRead(
      authQueryKeys.defaultCredentialsEnabled(),
      archestraApiSdk.getDefaultCredentialsStatus(options),
      (data) => data?.enabled ?? false,
    ),
    seedRead(
      environmentKeys.k8sCapabilities(),
      archestraApiSdk.getK8sCapabilities(options),
    ),
  ];
  if (params.route === "/mcp/registry") {
    reads.push(
      seedRead(
        mcpRegistryIssueIndexQueryKey,
        archestraApiSdk.getMcpRegistryIssueIndex(options),
      ),
    );
  }
  // The new-chat composer: one read for everything it needs to send.
  const composer =
    params.route === "/chat" && seedsNewChatComposer(params.search)
      ? readNewChatComposer(options)
      : Promise.resolve([]);
  const [shell, composerQueries] = await Promise.all([
    Promise.all(reads),
    composer,
  ]);
  return [...shell.filter((entry) => entry !== null), ...composerQueries];
}

async function readNewChatComposer(options: {
  headers: Record<string, string>;
  signal: AbortSignal;
}): Promise<ShellSeed["queries"]> {
  try {
    const { data, error } = await archestraApiSdk.getNewChatBootstrap(options);
    return error || !data ? [] : newChatSeedQueries(data);
  } catch {
    return [];
  }
}

async function seedRead<T>(
  queryKey: readonly unknown[],
  read: Promise<{ data?: T; error?: unknown }>,
  select: (data: T) => unknown = (data) => data,
) {
  try {
    const { data, error } = await read;
    if (error || data === undefined) return null;
    return { queryKey, data: select(data) };
  } catch {
    return null;
  }
}

/**
 * The session fields the app reads, picked rather than the token removed, so
 * a field the auth library adds later never lands in the HTML unreviewed.
 */
const SEED_SESSION_FIELDS = [
  "id",
  "userId",
  "activeOrganizationId",
  "impersonatedBy",
  "createdAt",
  "updatedAt",
  "expiresAt",
] as const;

function pickSeedSessionFields(
  session: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    SEED_SESSION_FIELDS.filter((field) => field in session).map((field) => [
      field,
      session[field],
    ]),
  );
}

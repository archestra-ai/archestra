import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { headers } from "next/headers";
import { isShellSeedRoute, SHELL_SEED_HEADER } from "@/lib/auth/shell-seed";
import { getBackendBaseUrl } from "@/lib/config/config";
import { mcpRegistryIssueIndexQueryKey } from "@/lib/mcp/mcp-registry.query";
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
   * Other shell data the page's route shows from the first render: the
   * registry's issue index, which the sidebar badge reads above the page.
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
  if (!isShellSeedRoute((await headers()).get(SHELL_SEED_HEADER))) return null;
  try {
    const apiHeaders = await getServerApiHeaders();
    const [session, bootstrap, issueIndex] = await withServerSeedDeadline(
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
          archestraApiSdk.getMcpRegistryIssueIndex({
            headers: apiHeaders,
            signal,
          }),
        ]),
    );
    if (!bootstrap.data) return null;
    if (!session?.user || !session.session) return null;
    return {
      session: { ...session, session: pickSeedSessionFields(session.session) },
      bootstrap: bootstrap.data,
      queries: issueIndex.data
        ? [{ queryKey: mcpRegistryIssueIndexQueryKey, data: issueIndex.data }]
        : [],
    };
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

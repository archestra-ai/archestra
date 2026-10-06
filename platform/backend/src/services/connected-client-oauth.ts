import type { ConnectedClientId } from "@/types/connected-client";

/** Claude Code's CIMD client_id: every install shares this one OAuth client. */
const CLAUDE_CODE_OAUTH_CLIENT_ID =
  "https://claude.ai/oauth/claude-code-client-metadata";

const AMP_CLIENT_NAME = /^Amp MCP Client \(.*\)$/;
const AMP_REDIRECT_URI = "http://localhost:41592/oauth/callback";

/** Agents recognised from their OAuth client alone, with no setup needed. */
export const OAUTH_ONLY_CLIENT_IDS = [
  "amp",
] as const satisfies ConnectedClientId[];

/**
 * Whether an OAuth client (the gateway's `oauth_client` row) belongs to a
 * Connect client, so disconnecting it can revoke the user's gateway grant.
 * Only clients with a stable, verified identity match; everything else
 * returns false and keeps its grant.
 */
export function isOAuthClientForConnectClient(
  clientId: ConnectedClientId,
  oauthClient: {
    clientId: string;
    name: string | null;
    redirectUris: string[];
  },
): boolean {
  switch (clientId) {
    case "claude-code":
      return oauthClient.clientId === CLAUDE_CODE_OAUTH_CLIENT_ID;
    case "amp":
      // Amp registers per install via DCR as "Amp MCP Client (<server name>)"
      // with this fixed loopback redirect (captured from amp 0.0.1791201662).
      return (
        AMP_CLIENT_NAME.test(oauthClient.name ?? "") &&
        oauthClient.redirectUris.includes(AMP_REDIRECT_URI)
      );
    default:
      return false;
  }
}

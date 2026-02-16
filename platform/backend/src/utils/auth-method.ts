import type { MCPGatewayAuthMethod } from "@/types";

const OAUTH_TOKEN_ID_PREFIX = "oauth:";

/**
 * Minimal token auth shape needed for auth method derivation.
 * Satisfied by both TokenAuthResult (mcp-gateway.utils) and TokenAuthContext (mcp-client).
 */
interface TokenAuthLike {
  tokenId: string;
  isOrganizationToken: boolean;
  isExternalIdp?: boolean;
  isUserToken?: boolean;
}

/**
 * Derive a human-readable auth method string from token auth context.
 * Shared between mcp-gateway.utils.ts and mcp-client.ts to avoid duplication.
 */
export function deriveAuthMethod(
  tokenAuth: TokenAuthLike | undefined,
): MCPGatewayAuthMethod | undefined {
  if (!tokenAuth) return undefined;
  if (tokenAuth.isExternalIdp) return "external_idp";
  if (tokenAuth.tokenId.startsWith(OAUTH_TOKEN_ID_PREFIX)) return "oauth";
  if (tokenAuth.isUserToken) return "user_token";
  if (tokenAuth.isOrganizationToken) return "org_token";
  return "team_token";
}

import type { archestraApiTypes } from "@archestra/shared";

type CredentialClientType = NonNullable<
  archestraApiTypes.GetMcpToolCallResponses["200"]["credentialClientType"]
>;

/** Who a tool call's exchanged enterprise credential was issued to. */
export function credentialClientLabel(
  clientType: CredentialClientType | null,
): string {
  return CREDENTIAL_CLIENT_LABEL[clientType ?? "identity_provider"];
}

// === internal ===

const CREDENTIAL_CLIENT_LABEL: Record<CredentialClientType, string> = {
  entra_agent_identity: "Entra agent identity",
  okta_ai_agent: "Okta AI agent",
  mcp_server: "MCP server's client",
  identity_provider: "Identity provider's client",
};

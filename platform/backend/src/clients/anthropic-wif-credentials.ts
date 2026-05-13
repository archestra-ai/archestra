import { identityTokenFromFile } from "@anthropic-ai/sdk/lib/credentials/identity-token";
import { oidcFederationProvider } from "@anthropic-ai/sdk/lib/credentials/oidc-federation";
import config from "@/config";

const ANTHROPIC_API_BASE_URL = "https://api.anthropic.com";

export function isAnthropicWifEnabled(): boolean {
  return config.llm.anthropic.wifEnabled;
}

export function getAnthropicWifCredentials(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
) {
  if (!isAnthropicWifEnabled()) {
    return undefined;
  }

  const {
    federationRuleId,
    organizationId,
    serviceAccountId,
    workspaceId,
    identityTokenFile,
  } = config.llm.anthropic;

  if (
    !federationRuleId ||
    !organizationId ||
    !serviceAccountId ||
    !workspaceId ||
    !identityTokenFile
  ) {
    throw new Error(
      "Anthropic WIF credentials are not fully configured. Ensure all ARCHESTRA_ANTHROPIC_* WIF environment variables are set.",
    );
  }

  return oidcFederationProvider({
    identityTokenProvider: identityTokenFromFile(identityTokenFile),
    federationRuleId,
    organizationId,
    serviceAccountId,
    workspaceId,
    baseURL: ANTHROPIC_API_BASE_URL,
    fetch: fetchImpl,
  });
}

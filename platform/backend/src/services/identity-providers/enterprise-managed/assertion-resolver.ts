import type { TokenAuthContext } from "@/clients/mcp-client";
import logger from "@/logging";
import { AgentModel } from "@/models";
import { findExternalIdentityProviderById } from "@/services/identity-providers/oidc";
import { resolveSessionExternalIdpToken } from "@/services/identity-providers/session-token";

interface EnterpriseAssertionResolution {
  assertion: string;
  identityProviderId: string;
  providerId: string;
}

export async function resolveEnterpriseAssertion(params: {
  agentId: string;
  identityProviderId?: string;
  tokenAuth?: TokenAuthContext;
}): Promise<EnterpriseAssertionResolution | null> {
  const agent = await AgentModel.findById(params.agentId);
  if (!agent) {
    return null;
  }

  const effectiveIdentityProviderId =
    params.identityProviderId ?? agent.identityProviderId;
  if (!effectiveIdentityProviderId) {
    return null;
  }

  const identityProvider = await findExternalIdentityProviderById(
    effectiveIdentityProviderId,
  );
  if (!identityProvider?.oidcConfig) {
    return null;
  }

  if (
    params.tokenAuth?.isExternalIdp &&
    params.tokenAuth.rawToken &&
    agent.identityProviderId &&
    effectiveIdentityProviderId === agent.identityProviderId
  ) {
    return {
      assertion: params.tokenAuth.rawToken,
      identityProviderId: effectiveIdentityProviderId,
      providerId: identityProvider.providerId,
    };
  }

  if (!params.tokenAuth?.userId) {
    return null;
  }

  const sessionToken = await resolveSessionExternalIdpToken({
    agentId: params.agentId,
    identityProviderId: effectiveIdentityProviderId,
    userId: params.tokenAuth.userId,
  });
  if (!sessionToken) {
    return null;
  }

  if (sessionToken.identityProviderId !== effectiveIdentityProviderId) {
    logger.warn(
      {
        agentId: params.agentId,
        userId: params.tokenAuth.userId,
        requestedIdentityProviderId: effectiveIdentityProviderId,
        sessionIdentityProviderId: sessionToken.identityProviderId,
      },
      "Enterprise assertion resolver: session token resolved for a different identity provider",
    );
    return null;
  }

  return {
    assertion: sessionToken.rawToken,
    identityProviderId: sessionToken.identityProviderId,
    providerId: sessionToken.providerId,
  };
}

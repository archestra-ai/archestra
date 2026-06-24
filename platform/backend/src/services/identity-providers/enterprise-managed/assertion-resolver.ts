// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import type { TokenAuthContext } from "@/clients/mcp-client";
import logger from "@/logging";
import { AgentModel } from "@/models";
import { findExternalIdentityProviderById } from "@/services/identity-providers/oidc";
import { resolveSessionExternalIdpToken } from "@/services/identity-providers/session-token";
import type { ToolOwner } from "@/types";

interface EnterpriseAssertionResolution {
  assertion: string;
  identityProviderId: string;
  providerId: string;
}

export async function resolveEnterpriseAssertion(params: {
  owner: ToolOwner;
  identityProviderId?: string;
  tokenAuth?: TokenAuthContext;
}): Promise<EnterpriseAssertionResolution | null> {
  // The IdP the owner is bound to. Agents may bind one (and an unknown agent
  // yields no assertion, as before); apps are never bound and rely entirely on
  // the config-provided identityProviderId.
  let ownerBoundIdentityProviderId: string | null;
  if (params.owner.type === "agent") {
    const agent = await AgentModel.findById(params.owner.id);
    if (!agent) {
      return null;
    }
    ownerBoundIdentityProviderId = agent.identityProviderId;
  } else {
    ownerBoundIdentityProviderId = null;
  }

  const effectiveIdentityProviderId =
    params.identityProviderId ?? ownerBoundIdentityProviderId;
  if (!effectiveIdentityProviderId) {
    return null;
  }

  const identityProvider = await findExternalIdentityProviderById(
    effectiveIdentityProviderId,
  );
  if (!identityProvider?.oidcConfig) {
    return null;
  }

  // Raw-token passthrough only when the owner is bound to the same IdP the
  // caller authenticated with. Apps (no bound IdP) always take the session path.
  if (
    params.tokenAuth?.isExternalIdp &&
    params.tokenAuth.rawToken &&
    ownerBoundIdentityProviderId &&
    effectiveIdentityProviderId === ownerBoundIdentityProviderId
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
    agentId: params.owner.type === "agent" ? params.owner.id : undefined,
    identityProviderId: effectiveIdentityProviderId,
    userId: params.tokenAuth.userId,
  });
  if (!sessionToken) {
    return null;
  }

  if (sessionToken.identityProviderId !== effectiveIdentityProviderId) {
    logger.warn(
      {
        ownerType: params.owner.type,
        ownerId: params.owner.id,
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

// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { isEntraHostname, isOktaHostname } from "@archestra/shared";
import logger from "@/logging";
import {
  type ExternalIdentityProviderConfig,
  findExternalIdentityProviderById,
} from "@/services/identity-providers/oidc";
import {
  ApiError,
  type EnterpriseCredentialClientType,
  type EnterpriseManagedCredentialConfig,
  type EnterpriseManagedCredentialType,
} from "@/types";
import { entraOboStrategy } from "./exchange-strategies/entra-obo-strategy";
import { oktaManagedCredentialExchangeStrategy } from "./exchange-strategies/okta-managed-credential-exchange";
import { rfc8693TokenExchangeStrategy } from "./exchange-strategies/rfc8693-token-exchange";

export interface EnterpriseCredentialExchangeParams {
  identityProvider: ExternalIdentityProviderConfig;
  assertion: string;
  enterpriseManagedConfig: EnterpriseManagedCredentialConfig;
  /**
   * The identity the calling agent acts as at this identity provider. `null`
   * for a caller (agent or app) with none; `undefined` when no agent is
   * calling, such as install-time tool discovery, which "require an agent
   * identity" does not apply to.
   */
  agentIdentity?: AgentIdentityContext | null;
}

/** The calling agent's binding at the identity provider an exchange runs at. */
export type AgentIdentityContext = {
  identityProviderId: string;
  externalId: string;
};

export type EnterpriseManagedCredentialResult = {
  credentialType: EnterpriseManagedCredentialType;
  expiresInSeconds: number | null;
  value: string | Record<string, unknown>;
  issuedTokenType: string | null;
  /** The client the credential was issued to, when the strategy knows it. */
  issuedTo?: EnterpriseCredentialIssuedTo;
  /**
   * The agent the exchange named as the actor (RFC 8693 `actor_token`), whose
   * client ID the issued token carries in `act`.
   */
  actor?: { clientId: string };
};

export type EnterpriseCredentialIssuedTo = {
  clientId: string;
  clientType: EnterpriseCredentialClientType;
};

export interface EnterpriseCredentialExchangeStrategy {
  exchangeCredential(
    params: EnterpriseCredentialExchangeParams,
  ): Promise<EnterpriseManagedCredentialResult>;
}

export async function exchangeEnterpriseManagedCredential(params: {
  identityProviderId: string;
  assertion: string;
  enterpriseManagedConfig: EnterpriseManagedCredentialConfig;
  agentIdentity?: AgentIdentityContext | null;
}): Promise<EnterpriseManagedCredentialResult> {
  const identityProvider = await findExternalIdentityProviderById(
    params.identityProviderId,
  );
  if (!identityProvider) {
    throw new Error("Enterprise identity provider not found");
  }
  // A binding names an identity at one provider; presenting it to another
  // would let the agent act as an identity that provider never issued.
  if (
    params.agentIdentity &&
    params.agentIdentity.identityProviderId !== identityProvider.id
  ) {
    throw new Error(
      "The agent identity binding belongs to a different identity provider than the one this exchange runs at",
    );
  }

  const strategy = getEnterpriseCredentialExchangeStrategy(identityProvider);
  logger.debug(
    {
      identityProviderId: identityProvider.id,
      providerId: identityProvider.providerId,
      strategy:
        strategy === entraOboStrategy
          ? "entra-obo"
          : strategy === oktaManagedCredentialExchangeStrategy
            ? "okta-managed-credential-exchange"
            : "rfc8693-token-exchange",
    },
    "Selected enterprise-managed credential exchange strategy",
  );
  return strategy.exchangeCredential({
    identityProvider,
    assertion: params.assertion,
    enterpriseManagedConfig: params.enterpriseManagedConfig,
    agentIdentity: params.agentIdentity,
  });
}

/**
 * Fails closed when the identity provider requires every agent to act through
 * its own identity and the calling agent has none. `agentIdentity` undefined
 * means no agent is calling, which the requirement does not apply to.
 */
export function assertAgentIdentityRequirement(params: {
  agentIdentity: AgentIdentityContext | null | undefined;
  requireAgentIdentity: boolean | undefined;
}): void {
  if (
    params.requireAgentIdentity &&
    params.agentIdentity !== undefined &&
    !params.agentIdentity
  ) {
    throw new ApiError(
      403,
      "This identity provider requires every agent to act through its own identity, and this agent has none. Bind one in the agent's settings.",
    );
  }
}

/**
 * How agents get their own identity at the identity provider, or null while it
 * is not set up: an Entra agent identity under an Entra Agent ID blueprint,
 * the agent's own client signed for with the provider's agent key (Okta AI
 * agents, RFC 8693 actors), or, for RFC 8693, the SPIFFE ID Archestra issues
 * every agent. Only the first two are bound per agent.
 */
export function agentIdentityKind(
  identityProvider: ExternalIdentityProviderConfig,
): "entra" | "client" | "spiffe" | null {
  const enterpriseConfig =
    identityProvider.oidcConfig?.enterpriseManagedCredentials;
  if (!enterpriseConfig) return null;
  const strategy = getEnterpriseCredentialExchangeStrategy(identityProvider);
  if (strategy === entraOboStrategy) {
    return enterpriseConfig.entraAgentId?.blueprintClientId?.trim()
      ? "entra"
      : null;
  }
  if (
    strategy === rfc8693TokenExchangeStrategy &&
    enterpriseConfig.agentIdentity?.source === "spiffe"
  ) {
    return "spiffe";
  }
  return enterpriseConfig.agentIdentity?.privateKeyPem ? "client" : null;
}

/**
 * Whether the identity provider refuses callers without their own identity:
 * the Entra Agent ID setting for an Entra On-Behalf-Of provider, the Agent
 * Identities setting for Okta and RFC 8693.
 */
export function identityProviderRequiresAgentIdentity(
  identityProvider: ExternalIdentityProviderConfig,
): boolean {
  const enterpriseConfig =
    identityProvider.oidcConfig?.enterpriseManagedCredentials;
  if (!enterpriseConfig) return false;
  return getEnterpriseCredentialExchangeStrategy(identityProvider) ===
    entraOboStrategy
    ? enterpriseConfig.entraAgentId?.requireAgentIdentity === true
    : enterpriseConfig.agentIdentity?.requireAgentIdentity === true;
}

function getEnterpriseCredentialExchangeStrategy(
  identityProvider: ExternalIdentityProviderConfig,
): EnterpriseCredentialExchangeStrategy {
  if (!identityProvider.oidcConfig?.enterpriseManagedCredentials) {
    throw new Error(
      `Enterprise-managed credentials are not configured for identity provider ${identityProvider.providerId}`,
    );
  }

  const configuredExchangeStrategy =
    identityProvider.oidcConfig.enterpriseManagedCredentials.exchangeStrategy;
  if (configuredExchangeStrategy === "entra_obo") {
    return entraOboStrategy;
  }

  if (configuredExchangeStrategy === "okta_managed") {
    return oktaManagedCredentialExchangeStrategy;
  }

  if (configuredExchangeStrategy === "rfc8693") {
    return rfc8693TokenExchangeStrategy;
  }

  if (supportsEntraObo(identityProvider)) {
    return entraOboStrategy;
  }

  if (supportsOktaManagedCredentialExchange(identityProvider)) {
    return oktaManagedCredentialExchangeStrategy;
  }

  return rfc8693TokenExchangeStrategy;
}

function supportsEntraObo(
  identityProvider: ExternalIdentityProviderConfig,
): boolean {
  const issuerUrl = tryParseIssuerUrl(identityProvider.issuer);
  return isEntraHostname(issuerUrl?.hostname ?? "");
}

function supportsOktaManagedCredentialExchange(
  identityProvider: ExternalIdentityProviderConfig,
): boolean {
  const issuerUrl = tryParseIssuerUrl(identityProvider.issuer);
  return isOktaHostname(issuerUrl?.hostname ?? "");
}

export function extractProviderErrorMessage(
  responseBody: Record<string, unknown> | null,
): string | null {
  if (!responseBody) {
    return null;
  }

  const description = responseBody.error_description;
  if (typeof description === "string" && description.length > 0) {
    return description;
  }

  const errorSummary = responseBody.errorSummary;
  if (typeof errorSummary === "string" && errorSummary.length > 0) {
    return errorSummary;
  }

  const error = responseBody.error;
  if (typeof error === "string" && error.length > 0) {
    return error;
  }

  return null;
}

function tryParseIssuerUrl(issuer: string): URL | null {
  try {
    return new URL(issuer);
  } catch {
    return null;
  }
}

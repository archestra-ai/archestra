import { isEntraHostname, isOktaHostname } from "@shared";
import logger from "@/logging";
import {
  type ExternalIdentityProviderConfig,
  findExternalIdentityProviderById,
} from "@/services/identity-providers/oidc";
import type {
  EnterpriseManagedCredentialConfig,
  EnterpriseManagedCredentialType,
} from "@/types";
import { entraOboStrategy } from "./exchange-strategies/entra-obo-strategy";
import { oktaManagedCredentialExchangeStrategy } from "./exchange-strategies/okta-managed-credential-exchange";
import { rfc8693TokenExchangeStrategy } from "./exchange-strategies/rfc8693-token-exchange";

export interface EnterpriseCredentialExchangeParams {
  identityProvider: ExternalIdentityProviderConfig;
  assertion: string;
  enterpriseManagedConfig: EnterpriseManagedCredentialConfig;
}

export type EnterpriseManagedCredentialResult = {
  credentialType: EnterpriseManagedCredentialType;
  expiresInSeconds: number | null;
  value: string | Record<string, unknown>;
  issuedTokenType: string | null;
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
}): Promise<EnterpriseManagedCredentialResult> {
  const identityProvider = await findExternalIdentityProviderById(
    params.identityProviderId,
  );
  if (!identityProvider) {
    throw new Error("Enterprise identity provider not found");
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
  });
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

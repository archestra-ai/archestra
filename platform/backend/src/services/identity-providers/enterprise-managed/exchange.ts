import {
  type ExternalIdentityProviderConfig,
  findExternalIdentityProviderById,
} from "@/services/identity-providers/oidc";
import type {
  EnterpriseManagedCredentialConfig,
  EnterpriseManagedCredentialType,
} from "@/types";
import { managedResourceTokenExchangeStrategy } from "./exchange-strategies/managed-resource-token-exchange";
import { standardTokenExchangeStrategy } from "./exchange-strategies/standard-token-exchange";

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
  return strategy.exchangeCredential({
    identityProvider,
    assertion: params.assertion,
    enterpriseManagedConfig: params.enterpriseManagedConfig,
  });
}

function getEnterpriseCredentialExchangeStrategy(
  identityProvider: ExternalIdentityProviderConfig,
): EnterpriseCredentialExchangeStrategy {
  if (supportsManagedResourceTokenExchange(identityProvider)) {
    return managedResourceTokenExchangeStrategy;
  }

  if (supportsStandardTokenExchange(identityProvider)) {
    return standardTokenExchangeStrategy;
  }

  throw new Error(
    `Enterprise-managed credentials are not supported for identity provider ${identityProvider.providerId}`,
  );
}

function supportsManagedResourceTokenExchange(
  identityProvider: ExternalIdentityProviderConfig,
): boolean {
  const configuredProviderType =
    identityProvider.oidcConfig?.enterpriseManagedCredentials?.providerType;
  if (configuredProviderType === "okta") {
    return true;
  }

  const issuerUrl = tryParseIssuerUrl(identityProvider.issuer);
  return isOktaHostname(issuerUrl?.hostname ?? "");
}

function supportsStandardTokenExchange(
  identityProvider: ExternalIdentityProviderConfig,
): boolean {
  const configuredProviderType =
    identityProvider.oidcConfig?.enterpriseManagedCredentials?.providerType;
  if (configuredProviderType === "keycloak") {
    return true;
  }

  const issuerUrl = tryParseIssuerUrl(identityProvider.issuer);
  return issuerUrl?.pathname.includes("/realms/") ?? false;
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

function isOktaHostname(hostname: string): boolean {
  if (hostname === "okta.com") {
    return true;
  }

  const hostnameParts = hostname.split(".");
  return (
    hostnameParts.length > 2 && hostnameParts.slice(-2).join(".") === "okta.com"
  );
}

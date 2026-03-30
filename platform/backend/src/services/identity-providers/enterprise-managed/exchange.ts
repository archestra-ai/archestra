import {
  type ExternalIdentityProviderConfig,
  findExternalIdentityProviderById,
} from "@/services/identity-providers/oidc";
import type { EnterpriseManagedCredentialConfig } from "@/types";
import {
  type EnterpriseManagedCredentialResult,
  standardTokenExchangeStrategy,
} from "./exchange-strategies/standard-token-exchange";
import { managedResourceTokenExchangeStrategy } from "./exchange-strategies/managed-resource-token-exchange";

export interface EnterpriseCredentialExchangeParams {
  identityProvider: ExternalIdentityProviderConfig;
  assertion: string;
  enterpriseManagedConfig: EnterpriseManagedCredentialConfig;
}

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

  return identityProvider.issuer.includes(".okta.com");
}

function supportsStandardTokenExchange(
  identityProvider: ExternalIdentityProviderConfig,
): boolean {
  const configuredProviderType =
    identityProvider.oidcConfig?.enterpriseManagedCredentials?.providerType;
  if (configuredProviderType === "keycloak") {
    return true;
  }

  return identityProvider.issuer.includes("/realms/");
}

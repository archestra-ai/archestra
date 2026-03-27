import {
  type ExternalIdentityProviderConfig,
  findExternalIdentityProviderById,
} from "@/services/external-idp-oidc";
import type { EnterpriseManagedCredentialConfig } from "@/types";
import {
  type EnterpriseManagedCredentialResult,
  keycloakEnterpriseCredentialExchangeAdapter,
} from "./keycloak";
import { oktaEnterpriseCredentialExchangeAdapter } from "./okta";

export interface EnterpriseCredentialExchangeParams {
  identityProvider: ExternalIdentityProviderConfig;
  assertion: string;
  enterpriseManagedConfig: EnterpriseManagedCredentialConfig;
}

export interface EnterpriseCredentialExchangeAdapter {
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

  const adapter = getEnterpriseCredentialExchangeAdapter(identityProvider);
  return adapter.exchangeCredential({
    identityProvider,
    assertion: params.assertion,
    enterpriseManagedConfig: params.enterpriseManagedConfig,
  });
}

function getEnterpriseCredentialExchangeAdapter(
  identityProvider: ExternalIdentityProviderConfig,
): EnterpriseCredentialExchangeAdapter {
  if (isOktaIdentityProvider(identityProvider)) {
    return oktaEnterpriseCredentialExchangeAdapter;
  }

  if (isKeycloakIdentityProvider(identityProvider)) {
    return keycloakEnterpriseCredentialExchangeAdapter;
  }

  throw new Error(
    `Enterprise-managed credentials are not supported for identity provider ${identityProvider.providerId}`,
  );
}

function isOktaIdentityProvider(
  identityProvider: ExternalIdentityProviderConfig,
): boolean {
  const configuredProviderType =
    identityProvider.oidcConfig?.enterpriseManagedCredentials?.providerType;
  if (configuredProviderType === "okta") {
    return true;
  }

  return identityProvider.issuer.includes(".okta.com");
}

function isKeycloakIdentityProvider(
  identityProvider: ExternalIdentityProviderConfig,
): boolean {
  const configuredProviderType =
    identityProvider.oidcConfig?.enterpriseManagedCredentials?.providerType;
  if (configuredProviderType === "keycloak") {
    return true;
  }

  return identityProvider.issuer.includes("/realms/");
}

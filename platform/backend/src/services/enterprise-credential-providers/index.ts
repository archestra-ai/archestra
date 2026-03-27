import {
  type ExternalIdentityProviderConfig,
  findExternalIdentityProviderById,
} from "@/services/external-idp-oidc";
import type { EnterpriseManagedCredentialConfig } from "@/types";
import {
  type EnterpriseManagedCredentialResult,
  oktaEnterpriseCredentialProvider,
} from "./okta";

export interface EnterpriseCredentialExchangeParams {
  identityProvider: ExternalIdentityProviderConfig;
  assertion: string;
  enterpriseManagedConfig: EnterpriseManagedCredentialConfig;
}

export interface EnterpriseCredentialProvider {
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

  const provider = getEnterpriseCredentialProvider(identityProvider);
  return provider.exchangeCredential({
    identityProvider,
    assertion: params.assertion,
    enterpriseManagedConfig: params.enterpriseManagedConfig,
  });
}

function getEnterpriseCredentialProvider(
  identityProvider: ExternalIdentityProviderConfig,
): EnterpriseCredentialProvider {
  if (isOktaIdentityProvider(identityProvider)) {
    return oktaEnterpriseCredentialProvider;
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

import type { IdentityProviderFormValues } from "@shared";

export function normalizeIdentityProviderFormValues(
  data: IdentityProviderFormValues,
): IdentityProviderFormValues {
  if (data.providerType !== "oidc" || !data.oidcConfig) {
    return data;
  }

  const enterpriseManagedCredentials =
    data.oidcConfig.enterpriseManagedCredentials;
  if (!enterpriseManagedCredentials) {
    return data;
  }

  const inferredExchangeType = inferEnterpriseExchangeType({
    issuer: data.issuer,
    providerId: data.providerId,
  });

  const hasConfiguredEnterpriseManagedFields = Object.values(
    enterpriseManagedCredentials,
  ).some((value) => {
    if (typeof value === "string") {
      return value.trim().length > 0;
    }

    return value !== undefined && value !== null;
  });

  if (!hasConfiguredEnterpriseManagedFields) {
    return data;
  }

  return {
    ...data,
    oidcConfig: {
      ...data.oidcConfig,
      enterpriseManagedCredentials: {
        providerType: enterpriseManagedCredentials.providerType
          ? enterpriseManagedCredentials.providerType
          : inferredExchangeType,
        ...enterpriseManagedCredentials,
        tokenEndpointAuthentication:
          enterpriseManagedCredentials.tokenEndpointAuthentication ??
          getDefaultTokenEndpointAuthentication(inferredExchangeType),
        subjectTokenType:
          enterpriseManagedCredentials.subjectTokenType ??
          getDefaultSubjectTokenType(inferredExchangeType),
      },
    },
  };
}

function inferEnterpriseExchangeType(params: {
  issuer: string;
  providerId: string;
}): "okta" | "keycloak" | "generic_oidc" {
  const issuer = params.issuer.toLowerCase();
  const providerId = params.providerId.toLowerCase();

  if (issuer.includes(".okta.com") || providerId.includes("okta")) {
    return "okta";
  }

  if (issuer.includes("/realms/") || providerId.includes("keycloak")) {
    return "keycloak";
  }

  return "generic_oidc";
}

function getDefaultTokenEndpointAuthentication(
  providerType: "okta" | "keycloak" | "generic_oidc",
): "private_key_jwt" | "client_secret_post" {
  return providerType === "keycloak" ? "client_secret_post" : "private_key_jwt";
}

function getDefaultSubjectTokenType(
  providerType: "okta" | "keycloak" | "generic_oidc",
):
  | "urn:ietf:params:oauth:token-type:access_token"
  | "urn:ietf:params:oauth:token-type:id_token" {
  return providerType === "keycloak"
    ? "urn:ietf:params:oauth:token-type:access_token"
    : "urn:ietf:params:oauth:token-type:id_token";
}

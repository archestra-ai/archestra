import {
  type IdentityProviderFormValues,
  isEntraHostname,
  isOktaHostname,
} from "@shared";

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
}): "okta" | "keycloak" | "entra_id" | "generic_oidc" {
  const providerId = params.providerId.toLowerCase();
  const parsedIssuer = tryParseIssuerUrl(params.issuer);
  const hostname = parsedIssuer?.hostname ?? "";

  if (isOktaHostname(hostname) || providerId.includes("okta")) {
    return "okta";
  }

  if (
    parsedIssuer?.pathname.includes("/realms/") ||
    providerId.includes("keycloak")
  ) {
    return "keycloak";
  }

  if (
    isEntraHostname(hostname) ||
    providerId.includes("entra") ||
    providerId.includes("azure")
  ) {
    return "entra_id";
  }

  return "generic_oidc";
}

function tryParseIssuerUrl(issuer: string): URL | null {
  try {
    return new URL(issuer);
  } catch {
    return null;
  }
}

function getDefaultTokenEndpointAuthentication(
  providerType: "okta" | "keycloak" | "entra_id" | "generic_oidc",
): "private_key_jwt" | "client_secret_post" {
  return providerType === "keycloak" || providerType === "entra_id"
    ? "client_secret_post"
    : "private_key_jwt";
}

function getDefaultSubjectTokenType(
  providerType: "okta" | "keycloak" | "entra_id" | "generic_oidc",
):
  | "urn:ietf:params:oauth:token-type:access_token"
  | "urn:ietf:params:oauth:token-type:id_token" {
  return providerType === "keycloak" || providerType === "entra_id"
    ? "urn:ietf:params:oauth:token-type:access_token"
    : "urn:ietf:params:oauth:token-type:id_token";
}

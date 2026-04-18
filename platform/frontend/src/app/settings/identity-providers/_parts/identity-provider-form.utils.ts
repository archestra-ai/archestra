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
        exchangeStrategy: enterpriseManagedCredentials.exchangeStrategy
          ? enterpriseManagedCredentials.exchangeStrategy
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

export function inferEnterpriseExchangeType(params: {
  issuer: string;
  providerId: string;
}): "okta_managed" | "rfc8693" | "entra_obo" {
  const providerId = params.providerId.toLowerCase();
  const parsedIssuer = tryParseIssuerUrl(params.issuer);
  const hostname = parsedIssuer?.hostname ?? "";

  if (isOktaHostname(hostname) || providerId.includes("okta")) {
    return "okta_managed";
  }

  if (
    parsedIssuer?.pathname.includes("/realms/") ||
    providerId.includes("keycloak")
  ) {
    return "rfc8693";
  }

  if (
    isEntraHostname(hostname) ||
    providerId.includes("entra") ||
    providerId.includes("azure")
  ) {
    return "entra_obo";
  }

  return "rfc8693";
}

function tryParseIssuerUrl(issuer: string): URL | null {
  try {
    return new URL(issuer);
  } catch {
    return null;
  }
}

export function getDefaultTokenEndpointAuthentication(
  exchangeStrategy: "okta_managed" | "rfc8693" | "entra_obo",
): "private_key_jwt" | "client_secret_post" {
  return exchangeStrategy === "rfc8693" || exchangeStrategy === "entra_obo"
    ? "client_secret_post"
    : "private_key_jwt";
}

export function getDefaultSubjectTokenType(
  exchangeStrategy: "okta_managed" | "rfc8693" | "entra_obo",
):
  | "urn:ietf:params:oauth:token-type:access_token"
  | "urn:ietf:params:oauth:token-type:id_token" {
  return exchangeStrategy === "rfc8693" || exchangeStrategy === "entra_obo"
    ? "urn:ietf:params:oauth:token-type:access_token"
    : "urn:ietf:params:oauth:token-type:id_token";
}

import {
  IDENTITY_PROVIDER_ID,
  type IdentityProviderFormValues,
  isEntraHostname,
  isOktaHostname,
} from "@shared";

export function normalizeIdentityProviderFormValues(
  data: IdentityProviderFormValues,
): IdentityProviderFormValues {
  if (data.providerType !== "oidc" || !data.oidcConfig) {
    return normalizeAllowedEmailDomains(data);
  }

  const normalizedData = normalizeAllowedEmailDomains(data);
  const oidcConfig = normalizeOidcIssuerFields(normalizedData);
  const enterpriseManagedCredentials = oidcConfig.enterpriseManagedCredentials;
  if (!enterpriseManagedCredentials) {
    return {
      ...normalizedData,
      oidcConfig,
    };
  }

  const inferredExchangeType = inferEnterpriseExchangeType({
    issuer: normalizedData.issuer,
    providerId: normalizedData.providerId,
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
    return {
      ...normalizedData,
      oidcConfig,
    };
  }

  return {
    ...normalizedData,
    oidcConfig: {
      ...oidcConfig,
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

export function normalizeAllowedEmailDomains(
  data: IdentityProviderFormValues,
): IdentityProviderFormValues {
  if (data.providerId === IDENTITY_PROVIDER_ID.GOOGLE) {
    return data;
  }

  return {
    ...data,
    domain: "",
  };
}

export function normalizeOidcIssuerFields(
  data: IdentityProviderFormValues,
): NonNullable<IdentityProviderFormValues["oidcConfig"]> {
  const oidcConfig = data.oidcConfig;
  if (!oidcConfig) {
    throw new Error("OIDC configuration is required");
  }

  const issuer = data.issuer.trim();
  const previousIssuer = oidcConfig.issuer?.trim() ?? "";
  const discoveryEndpoint = oidcConfig.discoveryEndpoint?.trim() ?? "";
  const defaultPreviousDiscoveryEndpoint = previousIssuer
    ? getDefaultDiscoveryEndpoint(previousIssuer)
    : "";

  return {
    ...oidcConfig,
    issuer,
    discoveryEndpoint:
      !discoveryEndpoint ||
      discoveryEndpoint === defaultPreviousDiscoveryEndpoint
        ? getDefaultDiscoveryEndpoint(issuer)
        : discoveryEndpoint,
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

function getDefaultDiscoveryEndpoint(issuer: string): string {
  return `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
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

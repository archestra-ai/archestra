// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  type archestraApiTypes,
  type IdentityProviderFormValues,
  isEntraHostname,
  isOktaHostname,
  OAUTH_TOKEN_TYPE,
} from "@archestra/shared";

export type EnterpriseSubjectTokenType = NonNullable<
  NonNullable<
    NonNullable<
      archestraApiTypes.CreateIdentityProviderData["body"]["oidcConfig"]
    >["enterpriseManagedCredentials"]
  >["subjectTokenType"]
>;

export function normalizeIdentityProviderFormValues(
  data: IdentityProviderFormValues,
): IdentityProviderFormValues {
  if (data.providerType !== "oidc" || !data.oidcConfig) {
    return data;
  }

  const issuerNormalizedConfig = normalizeOidcIssuerFields(data);
  const enterpriseManagedCredentials = withoutBlankEntraAgentId(
    issuerNormalizedConfig.enterpriseManagedCredentials,
  );
  const oidcConfig = {
    ...issuerNormalizedConfig,
    enterpriseManagedCredentials,
  };
  if (!enterpriseManagedCredentials) {
    return {
      ...data,
      oidcConfig,
    };
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
    return {
      ...data,
      oidcConfig,
    };
  }

  const exchangeStrategy =
    enterpriseManagedCredentials.exchangeStrategy || inferredExchangeType;

  return {
    ...data,
    oidcConfig: normalizeOidcConfigForEnterpriseExchange({
      oidcConfig,
      exchangeStrategy,
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
    }),
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

  return {
    ...oidcConfig,
    issuer,
    discoveryEndpoint: resolveDiscoveryEndpoint({ oidcConfig, issuer }),
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

/**
 * Keeps the discovery endpoint in step with the issuer the admin typed.
 *
 * A blank field, or one still holding the previous issuer's default, is
 * re-derived from the new issuer so renaming the issuer doesn't leave a stale
 * URL behind; anything the admin typed themselves is left alone.
 *
 * The exception is a provider registered with `skipDiscovery`: it has no
 * discovery document to point at, so a blank field means "there isn't one" and
 * must stay blank. Deriving `${issuer}/.well-known/openid-configuration` there
 * produces a URL the IdP does not serve — GitHub answers 404 — and registration
 * fails before any of the manually configured endpoints are reached.
 */
function resolveDiscoveryEndpoint(params: {
  oidcConfig: NonNullable<IdentityProviderFormValues["oidcConfig"]>;
  issuer: string;
}): string {
  const discoveryEndpoint = params.oidcConfig.discoveryEndpoint?.trim() ?? "";
  if (!discoveryEndpoint && params.oidcConfig.skipDiscovery) {
    return "";
  }

  const previousIssuer = params.oidcConfig.issuer?.trim() ?? "";
  const defaultPreviousDiscoveryEndpoint = previousIssuer
    ? getDefaultDiscoveryEndpoint(previousIssuer)
    : "";

  return !discoveryEndpoint ||
    discoveryEndpoint === defaultPreviousDiscoveryEndpoint
    ? getDefaultDiscoveryEndpoint(params.issuer)
    : discoveryEndpoint;
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
): EnterpriseSubjectTokenType {
  return exchangeStrategy === "rfc8693" || exchangeStrategy === "entra_obo"
    ? OAUTH_TOKEN_TYPE.AccessToken
    : OAUTH_TOKEN_TYPE.IdToken;
}

type EnterpriseManagedCredentialsFormValues = NonNullable<
  NonNullable<
    IdentityProviderFormValues["oidcConfig"]
  >["enterpriseManagedCredentials"]
>;

/**
 * Drops an Entra Agent ID block without a blueprint client ID (the section was
 * left empty), and its blank optional fields, so an untouched section neither
 * fails validation nor turns enterprise-managed credentials on by itself.
 */
function withoutBlankEntraAgentId(
  credentials: EnterpriseManagedCredentialsFormValues | undefined,
): EnterpriseManagedCredentialsFormValues | undefined {
  if (!credentials?.entraAgentId) return credentials;
  const { entraAgentId, ...rest } = credentials;
  const blueprintClientId = entraAgentId.blueprintClientId?.trim() ?? "";
  if (!blueprintClientId) {
    return Object.keys(rest).length > 0 ? rest : undefined;
  }

  const cleaned = Object.fromEntries(
    Object.entries(entraAgentId)
      .map(([key, value]) => [
        key,
        typeof value === "string" ? value.trim() : value,
      ])
      .filter(([, value]) => value !== "" && value !== undefined),
  ) as typeof entraAgentId;
  return { ...rest, entraAgentId: { ...cleaned, blueprintClientId } };
}

function normalizeOidcConfigForEnterpriseExchange(params: {
  oidcConfig: NonNullable<IdentityProviderFormValues["oidcConfig"]>;
  exchangeStrategy: "okta_managed" | "rfc8693" | "entra_obo";
  enterpriseManagedCredentials: NonNullable<
    NonNullable<
      IdentityProviderFormValues["oidcConfig"]
    >["enterpriseManagedCredentials"]
  >;
}): NonNullable<IdentityProviderFormValues["oidcConfig"]> {
  if (params.exchangeStrategy !== "entra_obo") {
    return {
      ...params.oidcConfig,
      enterpriseManagedCredentials: params.enterpriseManagedCredentials,
    };
  }

  const { userInfoEndpoint: _userInfoEndpoint, ...oidcConfig } =
    params.oidcConfig;

  return {
    ...oidcConfig,
    mapping: {
      ...oidcConfig.mapping,
      id: oidcConfig.mapping?.id ?? "sub",
      email: !oidcConfig.mapping?.email
        ? "preferred_username"
        : oidcConfig.mapping.email,
      name: oidcConfig.mapping?.name ?? "name",
    },
    enterpriseManagedCredentials: params.enterpriseManagedCredentials,
  };
}

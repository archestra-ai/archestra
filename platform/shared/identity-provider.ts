// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { z } from "zod";
import { DOMAIN_VALIDATION_REGEX } from "./incoming-email";

/**
 * Identity provider IDs - these are the canonical built-in provider identifiers used for:
 * - provider registration
 * - callback URLs (e.g. `/api/auth/sso/callback/{providerId}`)
 */
export const IDENTITY_PROVIDER_ID = {
  OKTA: "Okta",
  GOOGLE: "Google",
  GITHUB: "GitHub",
  GITLAB: "GitLab",
  ENTRA_ID: "EntraID",
} as const;

export type IdentityProviderId =
  (typeof IDENTITY_PROVIDER_ID)[keyof typeof IDENTITY_PROVIDER_ID];

/** List of canonical IDs used by the built-in identity provider templates. */
export const BUILT_IN_IDENTITY_PROVIDER_IDS =
  Object.values(IDENTITY_PROVIDER_ID);

export const OAUTH_TOKEN_TYPE = {
  AccessToken: "urn:ietf:params:oauth:token-type:access_token",
  IdToken: "urn:ietf:params:oauth:token-type:id_token",
  Jwt: "urn:ietf:params:oauth:token-type:jwt",
  IdJag: "urn:ietf:params:oauth:token-type:id-jag",
} as const;

export type OAuthTokenType =
  (typeof OAUTH_TOKEN_TYPE)[keyof typeof OAUTH_TOKEN_TYPE];

export const OAUTH_GRANT_TYPE = {
  TokenExchange: "urn:ietf:params:oauth:grant-type:token-exchange",
  JwtBearer: "urn:ietf:params:oauth:grant-type:jwt-bearer",
} as const;

export type OAuthGrantType =
  (typeof OAUTH_GRANT_TYPE)[keyof typeof OAUTH_GRANT_TYPE];

export const OAUTH_CLIENT_ASSERTION_TYPE = {
  JwtBearer: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
} as const;

export type OAuthClientAssertionType =
  (typeof OAUTH_CLIENT_ASSERTION_TYPE)[keyof typeof OAUTH_CLIENT_ASSERTION_TYPE];

export const ENTERPRISE_SUBJECT_TOKEN_TYPES = [
  OAUTH_TOKEN_TYPE.AccessToken,
  OAUTH_TOKEN_TYPE.IdToken,
  OAUTH_TOKEN_TYPE.Jwt,
] as const;

export type EnterpriseSubjectTokenType =
  (typeof ENTERPRISE_SUBJECT_TOKEN_TYPES)[number];

export function emailMatchesAllowedIdentityProviderDomains(
  email: string,
  allowedDomains: string,
) {
  const emailDomain = getEmailDomain(email);
  if (!emailDomain) {
    return false;
  }

  return parseAllowedIdentityProviderDomains(allowedDomains).some(
    (domain) => emailDomain === domain || emailDomain.endsWith(`.${domain}`),
  );
}

export function parseAllowedIdentityProviderDomains(allowedDomains: string) {
  return allowedDomains
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
}

export function getEmailDomain(email: string) {
  return email.split("@")[1]?.trim().toLowerCase() ?? null;
}

export const IdentityProviderOidcConfigSchema = z
  .object({
    issuer: z.string(),
    skipDiscovery: z.boolean().optional(),
    pkce: z.boolean(),
    enableRpInitiatedLogout: z.boolean().optional(),
    hd: z
      .string()
      .trim()
      .optional()
      .refine(
        (value) => !value || DOMAIN_VALIDATION_REGEX.test(value),
        "Enter a single valid domain, for example company.com",
      ),
    clientId: z.string(),
    clientSecret: z.string(),
    authorizationEndpoint: z.string().optional(),
    discoveryEndpoint: z.string(),
    userInfoEndpoint: z.string().optional(),
    scopes: z.array(z.string()).optional(),
    overrideUserInfo: z.boolean().optional(),
    tokenEndpoint: z.string().optional(),
    tokenEndpointAuthentication: z
      .enum(["client_secret_post", "client_secret_basic", "private_key_jwt"])
      .optional(),
    jwksEndpoint: z.string().optional(),
    enterpriseManagedCredentials: z
      .object({
        exchangeStrategy: z
          .enum(["rfc8693", "okta_managed", "entra_obo"])
          .optional(),
        clientId: z.string().optional(),
        clientSecret: z.string().optional(),
        tokenEndpoint: z.string().optional(),
        tokenEndpointAuthentication: z
          .enum([
            "client_secret_post",
            "client_secret_basic",
            "private_key_jwt",
          ])
          .optional(),
        privateKeyPem: z.string().optional(),
        privateKeyId: z.string().optional(),
        clientAssertionAudience: z.string().optional(),
        subjectTokenType: z.enum(ENTERPRISE_SUBJECT_TOKEN_TYPES).optional(),
      })
      .optional(),
    mapping: z
      .object({
        id: z.string().optional(),
        email: z.string().optional(),
        emailVerified: z.string().optional(),
        name: z.string().optional(),
        image: z.string().optional(),
        extraFields: z.record(z.string(), z.string()).optional(),
      })
      .optional()
      .describe(
        "https://github.com/better-auth/better-auth/blob/v1.4.0/packages/sso/src/types.ts#L3",
      ),
  })
  .describe(
    "https://github.com/better-auth/better-auth/blob/v1.4.0/packages/sso/src/types.ts#L22",
  );

export const IdentityProviderSamlConfigSchema = z
  .object({
    issuer: z.string(),
    entryPoint: z.string(),
    cert: z.string(),
    callbackUrl: z.string(),
    audience: z.string().optional(),
    idpMetadata: z
      .object({
        metadata: z.string().optional(),
        entityID: z.string().optional(),
        entityURL: z.string().optional(),
        redirectURL: z.string().optional(),
        cert: z.string().optional(),
        privateKey: z.string().optional(),
        privateKeyPass: z.string().optional(),
        isAssertionEncrypted: z.boolean().optional(),
        encPrivateKey: z.string().optional(),
        encPrivateKeyPass: z.string().optional(),
        singleSignOnService: z
          .array(
            z.object({
              Binding: z.string(),
              Location: z.string(),
            }),
          )
          .optional(),
      })
      .optional(),
    spMetadata: z.object({
      metadata: z.string().optional(),
      entityID: z.string().optional(),
      binding: z.string().optional(),
      privateKey: z.string().optional(),
      privateKeyPass: z.string().optional(),
      isAssertionEncrypted: z.boolean().optional(),
      encPrivateKey: z.string().optional(),
      encPrivateKeyPass: z.string().optional(),
    }),
    wantAssertionsSigned: z.boolean().optional(),
    signatureAlgorithm: z.string().optional(),
    digestAlgorithm: z.string().optional(),
    identifierFormat: z.string().optional(),
    privateKey: z.string().optional(),
    decryptionPvk: z.string().optional(),
    additionalParams: z.record(z.string(), z.any()).optional(),
    mapping: z
      .object({
        id: z.string().optional(),
        email: z.string().optional(),
        emailVerified: z.string().optional(),
        name: z.string().optional(),
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        extraFields: z.record(z.string(), z.string()).optional(),
      })
      .optional()
      .describe(
        "https://github.com/better-auth/better-auth/blob/v1.4.0/packages/sso/src/types.ts#L12C30-L20C2",
      ),
  })
  .describe(
    "https://github.com/better-auth/better-auth/blob/v1.4.0/packages/sso/src/types.ts#L40",
  );

/**
 * Config fields that hold credential material and must never leave the server.
 *
 * Paths are relative to the identity provider record, so they double as the
 * wire identifiers in `configuredSecretPaths` and let the backend redactor and
 * the frontend forms agree on one spelling.
 *
 * Deliberately NOT listed, because they are public by design and admins need to
 * read them back in the form:
 *  - `samlConfig.cert` / `samlConfig.idpMetadata.cert` — the IdP's X.509
 *    *signing* certificate, published in its metadata.
 *  - `samlConfig.spMetadata.metadata` / `samlConfig.idpMetadata.metadata` —
 *    SAML metadata XML, which carries public certificates only.
 *  - `oidcConfig.enterpriseManagedCredentials.privateKeyId` — a key
 *    *identifier*, not key material.
 */
export const IDENTITY_PROVIDER_SECRET_PATHS = [
  "oidcConfig.clientSecret",
  "oidcConfig.enterpriseManagedCredentials.clientSecret",
  "oidcConfig.enterpriseManagedCredentials.privateKeyPem",
  "samlConfig.privateKey",
  "samlConfig.decryptionPvk",
  "samlConfig.spMetadata.privateKey",
  "samlConfig.spMetadata.privateKeyPass",
  "samlConfig.spMetadata.encPrivateKey",
  "samlConfig.spMetadata.encPrivateKeyPass",
  "samlConfig.idpMetadata.privateKey",
  "samlConfig.idpMetadata.privateKeyPass",
  "samlConfig.idpMetadata.encPrivateKey",
  "samlConfig.idpMetadata.encPrivateKeyPass",
] as const;

export type IdentityProviderSecretPath =
  (typeof IDENTITY_PROVIDER_SECRET_PATHS)[number];

/**
 * OIDC config as it leaves the API: `clientSecret` is stripped, so the schema
 * that validates the response must not require it. Every other secret leaf is
 * already optional in the base schema.
 */
export const RedactedIdentityProviderOidcConfigSchema =
  IdentityProviderOidcConfigSchema.extend({
    clientSecret: z.string().optional(),
  });

/**
 * SAML config as it leaves the API, with the credentials it owns directly made
 * optional so the redacted shape stays valid even if the base schema starts
 * requiring one. The nested `spMetadata`/`idpMetadata` key material is already
 * optional there; `identity-provider.test.ts` asserts a fully redacted config
 * still parses, which is what catches it if that ever changes.
 */
export const RedactedIdentityProviderSamlConfigSchema =
  IdentityProviderSamlConfigSchema.extend({
    privateKey: z.string().optional(),
    decryptionPvk: z.string().optional(),
  });

/**
 * Strips every credential in `IDENTITY_PROVIDER_SECRET_PATHS` out of a provider
 * record and reports which of them were actually populated.
 *
 * Callers get presence without value: enough for a form to show "stored, leave
 * blank to keep" instead of an empty box that looks like the credential was
 * lost. Input is left untouched — internal callers (SSO login, token exchange)
 * keep reading the full config straight from the model.
 */
export function redactIdentityProviderSecrets<
  T extends IdentityProviderSecretCarrier,
>(provider: T): T & { configuredSecretPaths: IdentityProviderSecretPath[] } {
  const redacted = structuredClone(provider);
  const configuredSecretPaths: IdentityProviderSecretPath[] = [];

  for (const path of IDENTITY_PROVIDER_SECRET_PATHS) {
    if (deleteAtPath(redacted, path)) {
      configuredSecretPaths.push(path);
    }
  }

  return { ...redacted, configuredSecretPaths };
}

/**
 * Copies stored credentials forward onto an incoming update whose secret fields
 * came back blank.
 *
 * The API redacts secrets on read, so a client that loads a provider, renames
 * it and submits the whole config has no secret to send back. Treating that as
 * "clear the credential" would silently break SSO on an unrelated edit, so a
 * missing or empty secret means "keep what is stored" — the same contract the
 * env-var and MCP catalog secret bags use.
 *
 * A non-empty incoming value always wins, and a secret whose parent object was
 * dropped entirely (e.g. `enterpriseManagedCredentials` removed) is not
 * resurrected, which is how a credential gets cleared on purpose.
 */
export function preserveIdentityProviderSecrets<
  T extends IdentityProviderSecretCarrier,
>(params: { incoming: T; existing: IdentityProviderSecretCarrier }): T {
  const merged = structuredClone(params.incoming);

  for (const path of IDENTITY_PROVIDER_SECRET_PATHS) {
    const incomingValue = readAtPath(merged, path);
    if (typeof incomingValue === "string" && incomingValue.length > 0) {
      continue;
    }

    const existingValue = readAtPath(params.existing, path);
    if (typeof existingValue !== "string" || existingValue.length === 0) {
      continue;
    }

    writeAtPath(merged, path, existingValue);
  }

  return merged;
}

export const IdpRoleMappingRuleSchema = z.object({
  expression: z.string().min(1, "Expression is required"),
  role: z.string().min(1, "Role is required"),
});

export const IdpRoleMappingConfigSchema = z.object({
  rules: z.array(IdpRoleMappingRuleSchema).optional(),
  defaultRole: z.string().optional(),
  strictMode: z.boolean().optional(),
  skipRoleSync: z.boolean().optional(),
});

export type IdpRoleMappingRule = z.infer<typeof IdpRoleMappingRuleSchema>;
export type IdpRoleMappingConfig = z.infer<typeof IdpRoleMappingConfigSchema>;

export const IdpTeamSyncConfigSchema = z.object({
  groupsExpression: z.string().optional(),
  enabled: z.boolean().optional(),
});

export type IdpTeamSyncConfig = z.infer<typeof IdpTeamSyncConfigSchema>;

export function isOktaHostname(hostname: string): boolean {
  if (hostname === "okta.com") {
    return true;
  }

  const hostnameParts = hostname.split(".");
  return (
    hostnameParts.length > 2 && hostnameParts.slice(-2).join(".") === "okta.com"
  );
}

export function isEntraHostname(hostname: string): boolean {
  return (
    hostname === "login.microsoftonline.com" ||
    hostname === "sts.windows.net" ||
    hostname === "login.microsoft.com"
  );
}

export const IdentityProviderFormSchema = z
  .object({
    providerId: z.string().min(1, "Provider ID is required"),
    issuer: z.string().min(1, "Issuer is required"),
    ssoLoginEnabled: z.boolean().optional(),
    domain: z.string().refine(
      (value) => {
        const domains = parseAllowedIdentityProviderDomains(value);
        return (
          domains.length === 0 ||
          domains.every((domain) => DOMAIN_VALIDATION_REGEX.test(domain))
        );
      },
      {
        message:
          "Enter valid comma-separated domains, for example company.com, subsidiary.com",
      },
    ),
    providerType: z.enum(["oidc", "saml"]),
    oidcConfig: IdentityProviderOidcConfigSchema.optional(),
    samlConfig: IdentityProviderSamlConfigSchema.optional(),
    roleMapping: IdpRoleMappingConfigSchema.optional(),
    teamSyncConfig: IdpTeamSyncConfigSchema.optional(),
  })
  .refine(
    (data) => {
      if (data.providerType === "oidc") {
        return !!data.oidcConfig;
      }
      if (data.providerType === "saml") {
        return !!data.samlConfig;
      }
      return false;
    },
    {
      message: "Configuration is required for the selected provider type",
      path: ["oidcConfig"],
    },
  );

export type IdentityProviderOidcConfig = z.infer<
  typeof IdentityProviderOidcConfigSchema
>;
export type IdentityProviderSamlConfig = z.infer<
  typeof IdentityProviderSamlConfigSchema
>;
export type IdentityProviderFormValues = z.infer<
  typeof IdentityProviderFormSchema
>;

// ===========================================================================
// Internal helpers
// ===========================================================================

/**
 * Anything shaped enough to carry SSO credentials: the provider record itself,
 * or an update payload holding either config blob.
 */
type IdentityProviderSecretCarrier = {
  oidcConfig?: unknown;
  samlConfig?: unknown;
};

function readAtPath(source: unknown, path: string): unknown {
  let cursor: unknown = source;
  for (const segment of path.split(".")) {
    if (!isPlainRecord(cursor)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

/**
 * Removes the leaf at `path`. Returns whether a non-empty string was removed,
 * which is what makes a secret count as "configured": a stored empty string is
 * indistinguishable from an unset one for the form's purposes.
 */
function deleteAtPath(target: unknown, path: string): boolean {
  const segments = path.split(".");
  const leaf = segments.pop();
  if (!leaf) return false;

  let cursor: unknown = target;
  for (const segment of segments) {
    if (!isPlainRecord(cursor)) return false;
    cursor = cursor[segment];
  }
  if (!isPlainRecord(cursor)) return false;

  const value = cursor[leaf];
  delete cursor[leaf];
  return typeof value === "string" && value.length > 0;
}

/**
 * Writes `value` at `path` only when every parent object already exists. A
 * dropped parent means the caller removed that whole credential block, so
 * re-creating it here would undo a deliberate change.
 */
function writeAtPath(target: unknown, path: string, value: string): void {
  const segments = path.split(".");
  const leaf = segments.pop();
  if (!leaf) return;

  let cursor: unknown = target;
  for (const segment of segments) {
    if (!isPlainRecord(cursor)) return;
    cursor = cursor[segment];
  }
  if (!isPlainRecord(cursor)) return;

  cursor[leaf] = value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

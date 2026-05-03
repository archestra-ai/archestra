import { z } from "zod";
import { DOMAIN_VALIDATION_REGEX } from "./incoming-email";

/**
 * Identity provider IDs - these are the canonical built-in provider identifiers used for:
 * - account linking trust configuration
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

/** List of built-in identity provider IDs trusted for account linking. */
export const IDENTITY_TRUSTED_PROVIDER_IDS =
  Object.values(IDENTITY_PROVIDER_ID);

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
        subjectTokenType: z
          .enum([
            "urn:ietf:params:oauth:token-type:access_token",
            "urn:ietf:params:oauth:token-type:id_token",
            "urn:ietf:params:oauth:token-type:jwt",
          ])
          .optional(),
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

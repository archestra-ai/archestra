import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

/**
 * NOTE: better-auth doesn't export zod schemas for these types, so to make
 * form generation + request validation easier, we're defining them here.
 */
export const SsoProviderOidcConfigSchema = z
  .object({
    issuer: z.string(),
    pkce: z.boolean(),
    clientId: z.string(),
    clientSecret: z.string(),
    authorizationEndpoint: z.string().optional(),
    discoveryEndpoint: z.string(),
    userInfoEndpoint: z.string().optional(),
    scopes: z.array(z.string()).optional(),
    overrideUserInfo: z.boolean().optional(),
    tokenEndpoint: z.string().optional(),
    tokenEndpointAuthentication: z
      .enum(["client_secret_post", "client_secret_basic"])
      .optional(),
    jwksEndpoint: z.string().optional(),
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

export const SsoProviderSamlConfigSchema = z
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

const extendedFields = {
  oidcConfig: SsoProviderOidcConfigSchema.optional(),
  samlConfig: SsoProviderSamlConfigSchema.optional(),
};

export const SelectSsoProviderSchema = createSelectSchema(
  schema.ssoProvidersTable,
  extendedFields,
);
export const InsertSsoProviderSchema = createInsertSchema(
  schema.ssoProvidersTable,
  extendedFields,
);
export const UpdateSsoProviderSchema = createUpdateSchema(
  schema.ssoProvidersTable,
  extendedFields,
);

export type SsoProviderOidcConfig = z.infer<typeof SsoProviderOidcConfigSchema>;
export type SsoProviderSamlConfig = z.infer<typeof SsoProviderSamlConfigSchema>;

export type SsoProvider = z.infer<typeof SelectSsoProviderSchema>;
export type InsertSsoProvider = z.infer<typeof InsertSsoProviderSchema>;
export type UpdateSsoProvider = z.infer<typeof UpdateSsoProviderSchema>;

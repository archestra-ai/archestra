import {
  AzureBlobAuthMethodSchema,
  BlobProviderTypeSchema,
  GcsAuthMethodSchema,
  S3AuthMethodSchema,
} from "@archestra/shared";
import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database/schema";

// =============================================================================
// Per-provider settings. Adding a provider type: add its stored config, its
// request config and its credentials schemas here and to the unions below,
// implement a `BlobProvider` subclass, and register it in
// `blob-providers/registry.ts`.
// =============================================================================

// ----- Amazon S3 -------------------------------------------------------------

/** Non-secret settings of an S3 (or S3-compatible) bucket, as stored. */
export const S3BlobProviderConfigSchema = z.object({
  type: z.literal("s3"),
  bucket: z.string(),
  region: z.string(),
  /** Key prefix inside the bucket that every object is written under. */
  keyPrefix: z.string(),
  /** Custom endpoint for S3-compatible stores (MinIO, R2, Ceph, ...). */
  endpoint: z.string().nullable(),
  /** Path-style addressing, required by most S3-compatible stores. */
  forcePathStyle: z.boolean(),
  authMethod: S3AuthMethodSchema,
  /** `assume_role` only. */
  roleArn: z.string().nullable(),
  /** `assume_role` only: the external ID the role's trust policy requires. */
  externalId: z.string().nullable(),
});

/** The same settings as a request sends them: validated and normalized. */
const S3BlobProviderConfigInputSchema = z
  .object({
    type: z.literal("s3"),
    bucket: z.string().trim().min(1).max(255),
    region: z.string().trim().min(1).max(64),
    keyPrefix: keyPrefixInput(),
    endpoint: z
      .url({ protocol: /^https?$/ })
      .nullable()
      .optional(),
    forcePathStyle: z.boolean().default(false),
    authMethod: S3AuthMethodSchema,
    roleArn: z
      .string()
      .trim()
      .regex(/^arn:[\w-]+:iam::\d{12}:role\/.+$/, "Must be an IAM role ARN")
      .nullable()
      .optional(),
    externalId: z.string().trim().max(1224).nullable().optional(),
  })
  .refine((config) => config.authMethod !== "assume_role" || config.roleArn, {
    message: "The assume role auth method needs a role ARN",
    path: ["roleArn"],
  })
  .transform(
    (config): z.infer<typeof S3BlobProviderConfigSchema> => ({
      ...config,
      keyPrefix: normalizeKeyPrefix(config.keyPrefix),
      endpoint: config.endpoint || null,
      roleArn:
        config.authMethod === "assume_role" ? config.roleArn || null : null,
      externalId:
        config.authMethod === "assume_role" ? config.externalId || null : null,
    }),
  );

/** Secret part of an S3 provider: a static access key. */
export const S3BlobProviderCredentialsSchema = z.object({
  accessKeyId: z.string().trim().min(1, "Access key ID is required"),
  secretAccessKey: z.string().trim().min(1, "Secret access key is required"),
  sessionToken: z
    .string()
    .trim()
    .optional()
    .transform((value) => value || undefined),
});

// ----- Google Cloud Storage --------------------------------------------------

/** Non-secret settings of a Google Cloud Storage bucket, as stored. */
export const GcsBlobProviderConfigSchema = z.object({
  type: z.literal("gcs"),
  bucket: z.string(),
  keyPrefix: z.string(),
  authMethod: GcsAuthMethodSchema,
});

const GcsBlobProviderConfigInputSchema = z
  .object({
    type: z.literal("gcs"),
    bucket: z
      .string()
      .trim()
      .regex(
        /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/,
        "Must be a Cloud Storage bucket name (lowercase letters, digits, dashes, dots, underscores)",
      ),
    keyPrefix: keyPrefixInput(),
    authMethod: GcsAuthMethodSchema,
  })
  .transform(
    (config): z.infer<typeof GcsBlobProviderConfigSchema> => ({
      ...config,
      keyPrefix: normalizeKeyPrefix(config.keyPrefix),
    }),
  );

/** Secret part of a GCS provider: a service account JSON key. */
export const GcsBlobProviderCredentialsSchema = z.object({
  serviceAccountKey: z
    .string()
    .trim()
    .min(1, "Service account key is required")
    .refine((value) => {
      try {
        const key = JSON.parse(value);
        return (
          key?.type === "service_account" &&
          typeof key.client_email === "string" &&
          typeof key.private_key === "string"
        );
      } catch {
        return false;
      }
    }, "Must be a service account JSON key (type, client_email, private_key)"),
});

// ----- Azure Blob Storage ----------------------------------------------------

/** Non-secret settings of an Azure Blob Storage container, as stored. */
export const AzureBlobProviderConfigSchema = z.object({
  type: z.literal("azure_blob"),
  accountName: z.string(),
  container: z.string(),
  keyPrefix: z.string(),
  /**
   * Blob service endpoint, for sovereign clouds or Azurite. Null means
   * `https://<accountName>.blob.core.windows.net`.
   */
  endpoint: z.string().nullable(),
  authMethod: AzureBlobAuthMethodSchema,
  /** `service_principal` only. */
  tenantId: z.string().nullable(),
  /** `service_principal` only: the app registration's client ID. */
  clientId: z.string().nullable(),
});

const AzureBlobProviderConfigInputSchema = z
  .object({
    type: z.literal("azure_blob"),
    accountName: z
      .string()
      .trim()
      .regex(
        /^[a-z0-9]{3,24}$/,
        "Must be a storage account name (3-24 lowercase letters and digits)",
      ),
    container: z
      .string()
      .trim()
      .regex(
        /^(?!.*--)[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/,
        "Must be a container name (3-63 lowercase letters, digits and single dashes)",
      ),
    keyPrefix: keyPrefixInput(),
    endpoint: z
      .url({ protocol: /^https?$/ })
      .nullable()
      .optional(),
    authMethod: AzureBlobAuthMethodSchema,
    tenantId: z.string().trim().max(64).nullable().optional(),
    clientId: z.string().trim().max(64).nullable().optional(),
  })
  .refine(
    (config) =>
      config.authMethod !== "service_principal" ||
      (config.tenantId && config.clientId),
    {
      message:
        "The service principal auth method needs a tenant ID and a client ID",
      path: ["clientId"],
    },
  )
  .transform(
    (config): z.infer<typeof AzureBlobProviderConfigSchema> => ({
      ...config,
      keyPrefix: normalizeKeyPrefix(config.keyPrefix),
      endpoint: config.endpoint ? config.endpoint.replace(/\/+$/, "") : null,
      tenantId:
        config.authMethod === "service_principal"
          ? config.tenantId || null
          : null,
      clientId:
        config.authMethod === "service_principal"
          ? config.clientId || null
          : null,
    }),
  );

/** Secret part of an Azure provider; which field depends on the auth method. */
export const AzureBlobProviderCredentialsSchema = z.object({
  clientSecret: z.string().trim().min(1).optional(),
  accountKey: z.string().trim().min(1).optional(),
  sasToken: z
    .string()
    .trim()
    .min(1)
    .transform((value) => value.replace(/^\?/, ""))
    .optional(),
});

// ----- Unions ----------------------------------------------------------------

export const BlobProviderConfigSchema = z.discriminatedUnion("type", [
  S3BlobProviderConfigSchema,
  GcsBlobProviderConfigSchema,
  AzureBlobProviderConfigSchema,
]);

/** Request-side config: each member refines and normalizes its own type. */
const BlobProviderConfigInputSchema = z.union([
  S3BlobProviderConfigInputSchema,
  GcsBlobProviderConfigInputSchema,
  AzureBlobProviderConfigInputSchema,
]);

/**
 * Credentials as a request sends them: string fields whose shape depends on the
 * provider type and auth method (validated by the provider's registry entry).
 */
const BlobProviderCredentialsInputSchema = z
  .record(z.string(), z.string())
  .describe(
    "Write-only secrets for the auth method: `accessKeyId`, `secretAccessKey`, `sessionToken` (S3); `serviceAccountKey` (GCS); `clientSecret`, `accountKey` or `sasToken` (Azure).",
  );

// =============================================================================
// Rows and API shapes
// =============================================================================

export const SelectBlobProviderSchema = createSelectSchema(
  schema.blobProvidersTable,
  { type: BlobProviderTypeSchema, config: BlobProviderConfigSchema },
);

/** API shape: never carries the credentials or the secret reference. */
export const PublicBlobProviderSchema = SelectBlobProviderSchema.omit({
  secretId: true,
}).extend({
  hasCredentials: z
    .boolean()
    .describe("Whether static credentials are stored for this provider."),
  usedBy: z
    .object({
      costExports: z
        .array(z.string())
        .describe("Names of the cost exports that write to this provider."),
    })
    .describe(
      "What writes to this provider. A provider in use cannot be deleted.",
    ),
});

export const CreateBlobProviderRequestSchema = z.object({
  name: z.string().trim().min(1).max(256),
  config: BlobProviderConfigInputSchema,
  credentials: BlobProviderCredentialsInputSchema.optional(),
  skipConnectionTest: z
    .boolean()
    .optional()
    .describe(
      "Save without first writing and deleting a test object. By default a failed test rejects the request.",
    ),
});

export const UpdateBlobProviderRequestSchema = z.object({
  name: z.string().trim().min(1).max(256).optional(),
  config: BlobProviderConfigInputSchema.optional(),
  credentials: BlobProviderCredentialsInputSchema.optional().describe(
    "Write-only. Send only to replace the stored credentials.",
  ),
  clearCredentials: z
    .boolean()
    .optional()
    .describe("Remove the stored credentials."),
  skipConnectionTest: z
    .boolean()
    .optional()
    .describe(
      "Save without first writing and deleting a test object. By default a failed test rejects the request.",
    ),
});

export const BlobProviderTestResultSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});

export type BlobProviderConfig = z.infer<typeof BlobProviderConfigSchema>;
export type S3BlobProviderConfig = z.infer<typeof S3BlobProviderConfigSchema>;
export type S3BlobProviderCredentials = z.infer<
  typeof S3BlobProviderCredentialsSchema
>;
export type GcsBlobProviderConfig = z.infer<typeof GcsBlobProviderConfigSchema>;
export type GcsBlobProviderCredentials = z.infer<
  typeof GcsBlobProviderCredentialsSchema
>;
export type AzureBlobProviderConfig = z.infer<
  typeof AzureBlobProviderConfigSchema
>;
export type AzureBlobProviderCredentials = z.infer<
  typeof AzureBlobProviderCredentialsSchema
>;
/** Decrypted credentials of any provider type, as stored in the secret. */
export type BlobProviderCredentials =
  | S3BlobProviderCredentials
  | GcsBlobProviderCredentials
  | AzureBlobProviderCredentials;
export type BlobProviderRow = z.infer<typeof SelectBlobProviderSchema>;
export type PublicBlobProvider = z.infer<typeof PublicBlobProviderSchema>;
export type CreateBlobProviderRequest = z.infer<
  typeof CreateBlobProviderRequestSchema
>;
export type UpdateBlobProviderRequest = z.infer<
  typeof UpdateBlobProviderRequestSchema
>;

// =============================================================================
// Internal helpers
// =============================================================================

function keyPrefixInput() {
  return z.string().trim().max(512).default("");
}

function normalizeKeyPrefix(prefix: string): string {
  return prefix.replace(/^\/+|\/+$/g, "");
}

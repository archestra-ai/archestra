import { BlobProviderTypeSchema, S3AuthMethodSchema } from "@archestra/shared";
import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database/schema";

// =============================================================================
// Per-provider settings. Adding a provider type: add its config (and, when it
// has secrets, credentials) schema here and to the unions below, implement a
// `BlobProvider` subclass, and register it in `blob-providers/registry.ts`.
// =============================================================================

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
    keyPrefix: z.string().trim().max(512).default(""),
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
      keyPrefix: config.keyPrefix.replace(/^\/+|\/+$/g, ""),
      endpoint: config.endpoint || null,
      roleArn:
        config.authMethod === "assume_role" ? config.roleArn || null : null,
      externalId:
        config.authMethod === "assume_role" ? config.externalId || null : null,
    }),
  );

/** Secret part of an S3 provider: a static access key. */
const S3BlobProviderCredentialsSchema = z.object({
  accessKeyId: z.string().trim().min(1),
  secretAccessKey: z.string().trim().min(1),
  sessionToken: z
    .string()
    .trim()
    .optional()
    .transform((value) => value || undefined),
});

export const BlobProviderConfigSchema = z.discriminatedUnion("type", [
  S3BlobProviderConfigSchema,
]);

/**
 * Request-side config. One member today; with a second type, make this a
 * `z.union` of the input schemas (each refines and normalizes its own type).
 */
const BlobProviderConfigInputSchema = S3BlobProviderConfigInputSchema;

/** One member per provider type with secrets; union them as types are added. */
export const BlobProviderCredentialsSchema = S3BlobProviderCredentialsSchema;

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
});

export const CreateBlobProviderRequestSchema = z.object({
  name: z.string().trim().min(1).max(256),
  config: BlobProviderConfigInputSchema,
  credentials: BlobProviderCredentialsSchema.optional().describe(
    "Write-only. Required for the `access_key` auth method; optional source identity for `assume_role`.",
  ),
});

export const UpdateBlobProviderRequestSchema = z.object({
  name: z.string().trim().min(1).max(256).optional(),
  config: BlobProviderConfigInputSchema.optional(),
  credentials: BlobProviderCredentialsSchema.optional().describe(
    "Write-only. Send only to replace the stored credentials.",
  ),
  clearCredentials: z
    .boolean()
    .optional()
    .describe("Remove the stored credentials."),
});

export const BlobProviderTestResultSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});

export type BlobProviderConfig = z.infer<typeof BlobProviderConfigSchema>;
export type S3BlobProviderConfig = z.infer<typeof S3BlobProviderConfigSchema>;
export type BlobProviderCredentials = z.infer<
  typeof BlobProviderCredentialsSchema
>;
export type S3BlobProviderCredentials = z.infer<
  typeof S3BlobProviderCredentialsSchema
>;
export type BlobProviderRow = z.infer<typeof SelectBlobProviderSchema>;
export type PublicBlobProvider = z.infer<typeof PublicBlobProviderSchema>;
export type CreateBlobProviderRequest = z.infer<
  typeof CreateBlobProviderRequestSchema
>;
export type UpdateBlobProviderRequest = z.infer<
  typeof UpdateBlobProviderRequestSchema
>;

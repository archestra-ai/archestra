import { OrganizationCustomFontSchema, OrganizationThemeSchema } from "@shared";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

const DATA_URI_PREFIX = "data:image/png;base64,";
const MAX_LOGO_SIZE_BYTES = 2 * 1024 * 1024; // 2 MB decoded
const PNG_MAGIC_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Validates a Base64-encoded PNG data URI.
 *
 * Checks performed:
 * 1. Correct `data:image/png;base64,` prefix
 * 2. Valid Base64 encoding (round-trip check)
 * 3. Decoded size ≤ 2 MB
 * 4. PNG magic bytes (first 8 bytes of decoded data)
 */
const Base64PngSchema = z
  .string()
  .nullable()
  .superRefine((val, ctx) => {
    if (val === null) return;

    if (!val.startsWith(DATA_URI_PREFIX)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Logo must be a PNG image in data URI format",
      });
      return;
    }

    const base64Payload = val.slice(DATA_URI_PREFIX.length);

    // Validate Base64 encoding via round-trip
    const decoded = Buffer.from(base64Payload, "base64");
    if (decoded.toString("base64") !== base64Payload) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Logo contains invalid Base64 encoding",
      });
      return;
    }

    if (decoded.length > MAX_LOGO_SIZE_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Logo must be less than 2MB",
      });
      return;
    }

    // Verify PNG magic bytes
    if (
      decoded.length < PNG_MAGIC_BYTES.length ||
      !PNG_MAGIC_BYTES.every((byte, i) => decoded[i] === byte)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Logo must contain valid PNG image data",
      });
    }
  });

/**
 * Public appearance schema - used for unauthenticated access to branding settings.
 * Only exposes theme, logo, and font - no sensitive organization data.
 */
export const PublicAppearanceSchema = z.object({
  theme: OrganizationThemeSchema,
  customFont: OrganizationCustomFontSchema,
  logo: z.string().nullable(),
  logoDark: z.string().nullable(),
  favicon: z.string().nullable(),
  iconLogo: z.string().nullable(),
  appName: z.string().nullable(),
  ogDescription: z.string().nullable(),
  footerText: z.string().nullable(),
});

export const OrganizationLimitCleanupIntervalSchema = z
  .enum(["1h", "12h", "24h", "1w", "1m"])
  .nullable();

export const OrganizationCompressionScopeSchema = z.enum([
  "organization",
  "team",
]);

export const GlobalToolPolicySchema = z.enum(["permissive", "restrictive"]);

const extendedFields = {
  theme: OrganizationThemeSchema,
  customFont: OrganizationCustomFontSchema,
  limitCleanupInterval: OrganizationLimitCleanupIntervalSchema,
  compressionScope: OrganizationCompressionScopeSchema,
  globalToolPolicy: GlobalToolPolicySchema,
  embeddingModel: z.string().nullable(),
  embeddingDimensions: z.number().nullable(),
  defaultLlmModel: z.string().nullable(),
  defaultLlmProvider: z.string().nullable(),
  defaultAgentId: z.string().uuid().nullable(),
  favicon: z.string().nullable(),
  iconLogo: z.string().nullable(),
  appName: z.string().nullable(),
  ogDescription: z.string().nullable(),
  footerText: z.string().nullable(),
  chatPlaceholders: z.array(z.string()).nullable(),
  showTwoFactor: z.boolean(),
};

export const SelectOrganizationSchema = createSelectSchema(
  schema.organizationsTable,
  extendedFields,
);
export const InsertOrganizationSchema = createInsertSchema(
  schema.organizationsTable,
  extendedFields,
);
export const UpdateAppearanceSchema = z.object({
  theme: OrganizationThemeSchema.optional(),
  customFont: OrganizationCustomFontSchema.optional(),
  logo: Base64PngSchema.optional(),
  logoDark: Base64PngSchema.optional(),
  favicon: Base64PngSchema.optional(),
  iconLogo: Base64PngSchema.optional(),
  appName: z.string().max(100).nullable().optional(),
  ogDescription: z.string().max(500).nullable().optional(),
  footerText: z.string().max(500).nullable().optional(),
  chatPlaceholders: z.array(z.string().max(80)).max(20).nullable().optional(),
  showTwoFactor: z.boolean().optional(),
});

export const UpdateSecuritySettingsSchema = z.object({
  globalToolPolicy: GlobalToolPolicySchema.optional(),
  allowChatFileUploads: z.boolean().optional(),
});

export const UpdateLlmSettingsSchema = z.object({
  convertToolResultsToToon: z.boolean().optional(),
  compressionScope: OrganizationCompressionScopeSchema.optional(),
  limitCleanupInterval: OrganizationLimitCleanupIntervalSchema.optional(),
});

export const UpdateAgentSettingsSchema = z.object({
  defaultLlmModel: z.string().nullable().optional(),
  defaultLlmProvider: z.string().nullable().optional(),
  defaultLlmApiKeyId: z.string().uuid().nullable().optional(),
  defaultAgentId: z.string().uuid().nullable().optional(),
});

export const UpdateKnowledgeSettingsSchema = z.object({
  embeddingModel: z.string().min(1).optional(),
  embeddingDimensions: z.union([z.literal(1536), z.literal(768)]).optional(),
  embeddingChatApiKeyId: z.string().uuid().nullable().optional(),
  rerankerChatApiKeyId: z.string().uuid().nullable().optional(),
  rerankerModel: z.string().nullable().optional(),
});

export const CompleteOnboardingSchema = z.object({
  onboardingComplete: z.literal(true),
});

export type OrganizationLimitCleanupInterval = z.infer<
  typeof OrganizationLimitCleanupIntervalSchema
>;
export type OrganizationCompressionScope = z.infer<
  typeof OrganizationCompressionScopeSchema
>;
export type GlobalToolPolicy = z.infer<typeof GlobalToolPolicySchema>;
export type Organization = z.infer<typeof SelectOrganizationSchema>;
export type InsertOrganization = z.infer<typeof InsertOrganizationSchema>;
export type PublicAppearance = z.infer<typeof PublicAppearanceSchema>;

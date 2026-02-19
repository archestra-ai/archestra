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
};

export const SelectOrganizationSchema = createSelectSchema(
  schema.organizationsTable,
  extendedFields,
);
export const InsertOrganizationSchema = createInsertSchema(
  schema.organizationsTable,
  extendedFields,
);
export const UpdateOrganizationSchema = z.object({
  ...extendedFields,
  logo: Base64PngSchema,
  onboardingComplete: z.boolean(),
  convertToolResultsToToon: z.boolean(),
  compressionScope: OrganizationCompressionScopeSchema,
  autoConfigureNewTools: z.boolean(),
  globalToolPolicy: GlobalToolPolicySchema,
  allowChatFileUploads: z.boolean(),
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
export type UpdateOrganization = z.infer<typeof UpdateOrganizationSchema>;
export type PublicAppearance = z.infer<typeof PublicAppearanceSchema>;

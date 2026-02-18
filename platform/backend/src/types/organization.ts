import { OrganizationCustomFontSchema, OrganizationThemeSchema } from "@shared";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

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
const ALLOWED_LOGO_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
] as const;

const MAX_LOGO_SIZE_BYTES = 2 * 1024 * 1024; // 2MB

/**
 * Validates that a logo string is a valid data URI with an allowed image MIME type
 * and does not exceed the maximum size limit.
 */
const LogoSchema = z
  .string()
  .refine(
    (val) => {
      const match = val.match(
        /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/\n]+=*)$/,
      );
      if (!match) return false;

      const mimeType = match[1];
      if (
        !ALLOWED_LOGO_MIME_TYPES.includes(
          mimeType as (typeof ALLOWED_LOGO_MIME_TYPES)[number],
        )
      ) {
        return false;
      }

      // Validate base64 and check size
      const base64Data = match[2];
      const sizeInBytes = Math.ceil((base64Data.length * 3) / 4);
      return sizeInBytes <= MAX_LOGO_SIZE_BYTES;
    },
    {
      message: `Logo must be a valid base64-encoded data URI with an allowed image type (${ALLOWED_LOGO_MIME_TYPES.join(", ")}) and must not exceed 2MB`,
    },
  )
  .nullable();

export const UpdateOrganizationSchema = z.object({
  ...extendedFields,
  logo: LogoSchema,
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

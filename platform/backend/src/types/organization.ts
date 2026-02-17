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
const LOGO_DATA_URL_REGEX =
  /^data:(image\/(png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/;

const hasExpectedImageSignature = (mime: string, bytes: Buffer): boolean => {
  if (bytes.length < 4) {
    return false;
  }

  if (mime === "image/png") {
    return bytes.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  }

  if (mime === "image/jpeg" || mime === "image/jpg") {
    return bytes[0] === 0xff && bytes[1] === 0xd8;
  }

  if (mime === "image/gif") {
    return (
      bytes.subarray(0, 6).equals(Buffer.from("GIF87a")) ||
      bytes.subarray(0, 6).equals(Buffer.from("GIF89a"))
    );
  }

  if (mime === "image/webp") {
    return (
      bytes.subarray(0, 4).equals(Buffer.from("RIFF")) &&
      bytes.subarray(8, 12).equals(Buffer.from("WEBP"))
    );
  }

  return false;
};

const LogoSchema = z
  .string()
  .refine((value) => {
    const match = value.match(LOGO_DATA_URL_REGEX);

    if (!match) {
      return false;
    }

    const mime = match[1];
    const base64 = match[3];

    try {
      const decoded = Buffer.from(base64, "base64");

      return decoded.length > 0 && hasExpectedImageSignature(mime, decoded);
    } catch {
      return false;
    }
  }, "Logo must be a valid base64 encoded image data URL")
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

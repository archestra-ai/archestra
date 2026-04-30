import {
  MCP_OAUTH_ACCESS_TOKEN_MAX_LIFETIME_SECONDS,
  MCP_OAUTH_ACCESS_TOKEN_MIN_LIFETIME_SECONDS,
  OrganizationCustomFontSchema,
  OrganizationThemeSchema,
  SupportedProvidersSchema,
} from "@shared";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

const DATA_URI_PREFIX = "data:image/png;base64,";
const GIF_DATA_URI_PREFIX = "data:image/gif;base64,";
const MAX_LOGO_SIZE_BYTES = 2 * 1024 * 1024; // 2 MB decoded
const PNG_MAGIC_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
// "GIF87a" or "GIF89a"
const GIF87A_MAGIC_BYTES = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61];
const GIF89A_MAGIC_BYTES = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
const MAX_CHAT_LINK_URL_LENGTH = 2000;

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
 * Validates a Base64-encoded PNG or GIF data URI.
 *
 * Same 2MB cap as the PNG schema; also accepts GIF87a and GIF89a.
 * Used for onboarding-wizard page images (GIFs allowed so admins can embed
 * animated screen recordings).
 */
export const Base64ImageSchema = z
  .string()
  .nullable()
  .superRefine((val, ctx) => {
    if (val === null) return;

    const isPng = val.startsWith(DATA_URI_PREFIX);
    const isGif = val.startsWith(GIF_DATA_URI_PREFIX);
    if (!isPng && !isGif) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Image must be a PNG or GIF in data URI format",
      });
      return;
    }

    const base64Payload = val.slice(
      isPng ? DATA_URI_PREFIX.length : GIF_DATA_URI_PREFIX.length,
    );

    const decoded = Buffer.from(base64Payload, "base64");
    if (decoded.toString("base64") !== base64Payload) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Image contains invalid Base64 encoding",
      });
      return;
    }

    if (decoded.length > MAX_LOGO_SIZE_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Image must be less than 2MB",
      });
      return;
    }

    if (isPng) {
      if (
        decoded.length < PNG_MAGIC_BYTES.length ||
        !PNG_MAGIC_BYTES.every((byte, i) => decoded[i] === byte)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Image must contain valid PNG data",
        });
      }
      return;
    }

    // GIF
    const matchesGif87a =
      decoded.length >= GIF87A_MAGIC_BYTES.length &&
      GIF87A_MAGIC_BYTES.every((byte, i) => decoded[i] === byte);
    const matchesGif89a =
      decoded.length >= GIF89A_MAGIC_BYTES.length &&
      GIF89A_MAGIC_BYTES.every((byte, i) => decoded[i] === byte);
    if (!matchesGif87a && !matchesGif89a) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Image must contain valid GIF data",
      });
    }
  });

const ChatLinkUrlSchema = z
  .string()
  .trim()
  .max(MAX_CHAT_LINK_URL_LENGTH)
  .refine((value) => isValidHttpUrl(value), {
    message: "Chat link URL must be a valid HTTP or HTTPS URL",
  });

export const OrganizationChatLinkSchema = z.object({
  label: z.string().trim().min(1).max(25),
  url: ChatLinkUrlSchema,
});

/**
 * Admin-curated metadata for a connection base URL. The URL itself is still
 * supplied via `NEXT_PUBLIC_ARCHESTRA_API_BASE_URL`; this lets admins attach a
 * human description and pick one as the default for the /connection page.
 */
export const ConnectionBaseUrlSchema = z.object({
  url: z.string().trim().min(1).max(2000),
  description: z.string().trim().max(500).default(""),
  isDefault: z.boolean().default(false),
  visible: z.boolean().default(true),
});

export const OnboardingWizardPageSchema = z.object({
  image: Base64ImageSchema.optional(),
  content: z.string(),
});

export const OnboardingWizardSchema = z.object({
  label: z.string().trim().min(1).max(25),
  pages: z.array(OnboardingWizardPageSchema).min(1).max(10),
});

/**
 * Appearance settings schema - used for unauthenticated access to branding settings.
 * Only exposes theme, logo, and font - no sensitive organization data.
 */
export const AppearanceSettingsSchema = z.object({
  theme: OrganizationThemeSchema,
  customFont: OrganizationCustomFontSchema,
  logo: z.string().nullable(),
  logoDark: z.string().nullable(),
  favicon: z.string().nullable(),
  iconLogo: z.string().nullable(),
  appName: z.string().nullable(),
  ogDescription: z.string().nullable(),
  footerText: z.string().nullable(),
  chatLinks: z.array(OrganizationChatLinkSchema).nullable(),
  onboardingWizard: OnboardingWizardSchema.nullable(),
  chatErrorSupportMessage: z.string().nullable(),
  slimChatErrorUi: z.boolean(),
  animateChatPlaceholders: z.boolean(),
});

export const OrganizationLimitCleanupIntervalSchema = z
  .enum(["1h", "12h", "24h", "1w", "1m"])
  .nullable();

export const OrganizationCompressionScopeSchema = z.enum([
  "organization",
  "team",
]);

export const GlobalToolPolicySchema = z.enum(["permissive", "restrictive"]);
export const McpOauthAccessTokenLifetimeSecondsSchema = z
  .number()
  .int()
  .min(MCP_OAUTH_ACCESS_TOKEN_MIN_LIFETIME_SECONDS)
  .max(MCP_OAUTH_ACCESS_TOKEN_MAX_LIFETIME_SECONDS);

const extendedFields = {
  theme: OrganizationThemeSchema,
  customFont: OrganizationCustomFontSchema,
  limitCleanupInterval: OrganizationLimitCleanupIntervalSchema,
  compressionScope: OrganizationCompressionScopeSchema,
  globalToolPolicy: GlobalToolPolicySchema,
  embeddingModel: z.string().nullable(),
  embeddingDimensions: z.number().nullable(),
  defaultLlmModel: z.string().nullable(),
  defaultLlmProvider: SupportedProvidersSchema.nullable(),
  defaultAgentId: z.string().uuid().nullable(),
  favicon: z.string().nullable(),
  iconLogo: z.string().nullable(),
  appName: z.string().nullable(),
  ogDescription: z.string().nullable(),
  footerText: z.string().nullable(),
  chatLinks: z.array(OrganizationChatLinkSchema).nullable(),
  onboardingWizard: OnboardingWizardSchema.nullable(),
  chatErrorSupportMessage: z.string().nullable(),
  slimChatErrorUi: z.boolean(),
  chatPlaceholders: z.array(z.string()).nullable(),
  animateChatPlaceholders: z.boolean(),
  showTwoFactor: z.boolean(),
  mcpOauthAccessTokenLifetimeSeconds: McpOauthAccessTokenLifetimeSecondsSchema,
  connectionBaseUrls: z.array(ConnectionBaseUrlSchema).nullable(),
};

export const SelectOrganizationSchema = createSelectSchema(
  schema.organizationsTable,
  extendedFields,
);
export const InsertOrganizationSchema = createInsertSchema(
  schema.organizationsTable,
  extendedFields,
);
export const UpdateAppearanceSettingsSchema = z.object({
  theme: OrganizationThemeSchema.optional(),
  customFont: OrganizationCustomFontSchema.optional(),
  logo: Base64PngSchema.optional(),
  logoDark: Base64PngSchema.optional(),
  favicon: Base64PngSchema.optional(),
  iconLogo: Base64PngSchema.optional(),
  appName: z.string().max(100).nullable().optional(),
  ogDescription: z.string().max(500).nullable().optional(),
  footerText: z.string().max(500).nullable().optional(),
  chatLinks: z.array(OrganizationChatLinkSchema).max(3).nullable().optional(),
  onboardingWizard: OnboardingWizardSchema.nullable().optional(),
  chatErrorSupportMessage: z.string().max(500).nullable().optional(),
  slimChatErrorUi: z.boolean().optional(),
  chatPlaceholders: z.array(z.string().max(80)).max(20).nullable().optional(),
  animateChatPlaceholders: z.boolean().optional(),
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
  defaultLlmProvider: SupportedProvidersSchema.nullable().optional(),
  defaultLlmApiKeyId: z.string().uuid().nullable().optional(),
  defaultAgentId: z.string().uuid().nullable().optional(),
});

export const UpdateKnowledgeSettingsSchema = z.object({
  embeddingModel: z.string().min(1).nullable().optional(),
  embeddingChatApiKeyId: z.string().uuid().nullable().optional(),
  rerankerChatApiKeyId: z.string().uuid().nullable().optional(),
  rerankerModel: z.string().nullable().optional(),
});

export const UpdateMcpSettingsSchema = z.object({
  mcpOauthAccessTokenLifetimeSeconds:
    McpOauthAccessTokenLifetimeSecondsSchema.optional(),
});

export const UpdateConnectionSettingsSchema = z.object({
  connectionDefaultMcpGatewayId: z.string().uuid().nullable().optional(),
  connectionDefaultLlmProxyId: z.string().uuid().nullable().optional(),
  connectionDefaultClientId: z.string().max(64).nullable().optional(),
  connectionShownClientIds: z
    .array(z.string().max(64))
    .max(50)
    .nullable()
    .optional(),
  connectionShownProviders: z
    .array(SupportedProvidersSchema)
    .nullable()
    .optional(),
  connectionBaseUrls: z
    .array(ConnectionBaseUrlSchema)
    .max(50)
    .nullable()
    .optional()
    .superRefine((value, ctx) => {
      if (!value) return;
      const seen = new Set<string>();
      let defaults = 0;
      for (const item of value) {
        if (seen.has(item.url)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Duplicate connection base URL",
          });
        }
        seen.add(item.url);
        if (item.isDefault) defaults += 1;
      }
      if (defaults > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Only one connection base URL can be marked as default",
        });
      }
    }),
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
export type AppearanceSettings = z.infer<typeof AppearanceSettingsSchema>;
export type OrganizationChatLink = z.infer<typeof OrganizationChatLinkSchema>;
export type OnboardingWizardPage = z.infer<typeof OnboardingWizardPageSchema>;
export type OnboardingWizard = z.infer<typeof OnboardingWizardSchema>;
export type McpOauthAccessTokenLifetimeSeconds = z.infer<
  typeof McpOauthAccessTokenLifetimeSecondsSchema
>;
export type ConnectionBaseUrl = z.infer<typeof ConnectionBaseUrlSchema>;

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

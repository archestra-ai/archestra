import { ResourceVisibilityScopeSchema } from "@archestra/shared";
import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const PLUGIN_MAX_FILES = 100;
export const PLUGIN_MAX_FILE_BYTES = 750 * 1024;
export const PLUGIN_MAX_TOTAL_BYTES = 5 * 1024 * 1024;
export const PLUGIN_DELIVERY_MAX_COUNT = 50;
export const PLUGIN_DELIVERY_MAX_BYTES = 100 * 1024 * 1024;

export const ClientTypeSchema = z.enum([
  "claude-code",
  "copilot-cli",
  "codex",
  "cursor",
]);
export type ClientType = z.infer<typeof ClientTypeSchema>;

export const PluginSourceKindSchema = z.enum(["manual", "github"]);
export type PluginSourceKind = z.infer<typeof PluginSourceKindSchema>;

export const PluginGithubSyncIntervalSchema = z.enum(["15m", "1h", "1d"]);
export type PluginGithubSyncInterval = z.infer<
  typeof PluginGithubSyncIntervalSchema
>;

export const PluginPlatformSchema = z.enum(["posix", "windows"]);
export type PluginPlatform = z.infer<typeof PluginPlatformSchema>;

export const PluginFileEncodingSchema = z.enum(["utf8", "base64"]);
export type PluginFileEncoding = z.infer<typeof PluginFileEncodingSchema>;

export const PluginFileModeSchema = z.enum(["100644", "100755"]);
export type PluginFileMode = z.infer<typeof PluginFileModeSchema>;

export const SelectPluginSchema = createSelectSchema(schema.pluginsTable, {
  clientType: ClientTypeSchema,
  supportedPlatforms: z.array(PluginPlatformSchema).min(1),
  sourceKind: PluginSourceKindSchema,
  scope: ResourceVisibilityScopeSchema,
  githubSyncInterval: z.union([PluginGithubSyncIntervalSchema, z.null()]),
});

export const SelectPluginFileSchema = createSelectSchema(
  schema.pluginFilesTable,
  {
    encoding: PluginFileEncodingSchema,
    mode: PluginFileModeSchema,
  },
);

export const PluginFileInputSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(512)
    .refine(isSafePluginPath, "File path must be a safe relative path"),
  content: z.string().max(1_024_000),
  encoding: PluginFileEncodingSchema.default("utf8"),
  mode: PluginFileModeSchema.default("100644"),
});

export const PluginFileSetSchema = z
  .object({
    files: z.array(PluginFileInputSchema).min(1).max(PLUGIN_MAX_FILES),
  })
  .superRefine(validateFileSet);

export const CreatePluginSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120),
    description: z.string().max(1_000).default(""),
    clientType: ClientTypeSchema,
    supportedPlatforms: z.array(PluginPlatformSchema).min(1).optional(),
    scope: ResourceVisibilityScopeSchema.optional(),
    teamIds: z.array(z.string().min(1)).max(100).optional(),
    userIds: z.array(z.string().min(1)).max(100).optional(),
    files: z.array(PluginFileInputSchema).min(1).max(PLUGIN_MAX_FILES),
  })
  .superRefine(validateFileSet);

export const UpdatePluginSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120).optional(),
    description: z.string().max(1_000).optional(),
    enabled: z.boolean().optional(),
    supportedPlatforms: z.array(PluginPlatformSchema).min(1).optional(),
    scope: ResourceVisibilityScopeSchema.optional(),
    teamIds: z.array(z.string().min(1)).max(100).optional(),
    userIds: z.array(z.string().min(1)).max(100).optional(),
    githubSource: z
      .object({
        repoUrl: z.string().trim().min(1).max(2_048),
        ref: z.union([z.string().trim().min(1).max(1_024), z.null()]),
        syncInterval: z.union([PluginGithubSyncIntervalSchema, z.null()]),
        authentication: z
          .object({
            githubAppConfigId: z.string().uuid().nullable(),
            githubPatId: z.string().uuid().nullable(),
          })
          .refine(
            (value) =>
              [value.githubAppConfigId, value.githubPatId].filter(Boolean)
                .length <= 1,
            { message: "Choose only one GitHub authentication method" },
          )
          .optional(),
      })
      .optional(),
    files: z
      .array(PluginFileInputSchema)
      .min(1)
      .max(PLUGIN_MAX_FILES)
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (Object.keys(value).length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "At least one field is required",
      });
    }
    if (value.files) validateFileSet(value, ctx);
  });

export const PluginTeamSchema = z.object({ id: z.string(), name: z.string() });
export const PluginUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
});

const PublicPluginSchema = SelectPluginSchema.omit({ syncGeneration: true });

export const PluginWithVisibilitySchema = PublicPluginSchema.extend({
  teams: z.array(PluginTeamSchema),
  users: z.array(PluginUserSchema),
});

export const PluginWithFilesSchema = PluginWithVisibilitySchema.extend({
  files: z.array(SelectPluginFileSchema),
});

export const PluginListItemSchema = PublicPluginSchema.omit({
  githubAppConfigId: true,
  githubPatId: true,
  lastSyncError: true,
}).extend({
  teams: z.array(PluginTeamSchema),
  users: z.array(PluginUserSchema),
  fileCount: z.number().int().nonnegative(),
});

export type Plugin = z.infer<typeof SelectPluginSchema>;
export type PluginFile = z.infer<typeof SelectPluginFileSchema>;
export type PluginFileInput = z.infer<typeof PluginFileInputSchema>;
export type CreatePlugin = z.infer<typeof CreatePluginSchema>;
export type UpdatePlugin = z.infer<typeof UpdatePluginSchema>;
export type PluginWithVisibility = z.infer<typeof PluginWithVisibilitySchema>;
export type PluginWithFiles = z.infer<typeof PluginWithFilesSchema>;
export type PluginListItem = z.infer<typeof PluginListItemSchema>;

export function isSafePluginPath(value: string): boolean {
  if (value.includes("\0") || value.includes("\\")) return false;
  if (value.startsWith("/") || value.endsWith("/") || value.includes("//")) {
    return false;
  }
  return !value
    .split("/")
    .some((segment) => segment === "." || segment === "..");
}

export function validateFileSet(
  value: { files?: PluginFileInput[] },
  ctx: z.RefinementCtx,
): void {
  const files = value.files ?? [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const [index, file] of files.entries()) {
    const lower = file.path.toLowerCase();
    if (seen.has(lower)) {
      ctx.addIssue({
        code: "custom",
        path: ["files", index, "path"],
        message: "File paths must be unique ignoring case",
      });
    }
    seen.add(lower);
    const canonicalBase64 =
      file.encoding !== "base64" || isCanonicalBase64(file.content);
    if (!canonicalBase64) {
      ctx.addIssue({
        code: "custom",
        path: ["files", index, "content"],
        message: "Base64 file content must be canonical and padded",
      });
    }
    const byteLength = canonicalBase64
      ? file.encoding === "base64"
        ? Buffer.from(file.content, "base64").length
        : Buffer.byteLength(file.content, "utf8")
      : 0;
    if (byteLength > PLUGIN_MAX_FILE_BYTES) {
      ctx.addIssue({
        code: "custom",
        path: ["files", index, "content"],
        message: `File exceeds ${PLUGIN_MAX_FILE_BYTES} decoded bytes`,
      });
    }
    totalBytes += byteLength;
  }
  if (totalBytes > PLUGIN_MAX_TOTAL_BYTES) {
    ctx.addIssue({
      code: "custom",
      path: ["files"],
      message: `Plugin exceeds ${PLUGIN_MAX_TOTAL_BYTES} decoded bytes`,
    });
  }
}

function isCanonicalBase64(value: string): boolean {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    return false;
  }
  return Buffer.from(value, "base64").toString("base64") === value;
}

import { ResourceVisibilityScopeSchema } from "@archestra/shared";
import { z } from "zod";
import {
  ClientTypeSchema,
  PluginFileEncodingSchema,
  PluginPlatformSchema,
} from "./plugin";

/**
 * Skills projected from plugin file trees. A plugin ships client-native
 * payloads, but any `SKILL.md` it carries follows the portable Agent Skills
 * format, so the Skills page can surface it for reuse — read-only, derived
 * from the approved plugin bytes, never stored as a standalone skill.
 */
export const PluginSkillListItemSchema = z.object({
  source: z.literal("plugin"),
  pluginId: z.string().uuid(),
  pluginName: z.string(),
  pluginSlug: z.string(),
  sourceRepo: z.string().nullable(),
  sourceMarketplaceRepo: z.string().nullable(),
  pluginEnabled: z.boolean(),
  scope: ResourceVisibilityScopeSchema,
  /** Provenance only: SKILL.md instructions are portable across clients/OSes. */
  clientType: ClientTypeSchema,
  supportedPlatforms: z.array(PluginPlatformSchema),
  /** Parent directory of the SKILL.md inside the plugin; "" for the root. */
  skillPath: z.string(),
  name: z.string(),
  description: z.string(),
  compatibility: z.string().nullable(),
  fileCount: z.number().int().nonnegative(),
  usageCount: z.number().int().nonnegative(),
  usageUserCount: z.number().int().nonnegative(),
  lastUsedAt: z.date().nullable(),
});

export const PluginSkillFileSchema = z.object({
  /** Path relative to the skill root. */
  path: z.string(),
  content: z.string(),
  encoding: PluginFileEncodingSchema,
  kind: z.enum(["script", "reference", "asset"]),
});

export const PluginSkillDetailSchema = PluginSkillListItemSchema.extend({
  /** Exact stored SKILL.md bytes, including frontmatter. */
  manifest: z.string(),
  /** The SKILL.md markdown body, frontmatter stripped. */
  content: z.string(),
  allowedTools: z.string().nullable(),
  files: z.array(PluginSkillFileSchema),
});

export type PluginSkillListItem = z.infer<typeof PluginSkillListItemSchema>;
export type PluginSkillFile = z.infer<typeof PluginSkillFileSchema>;
export type PluginSkillDetail = z.infer<typeof PluginSkillDetailSchema>;

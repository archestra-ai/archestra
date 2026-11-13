import {
  AGENT_CATALOG_NAMES,
  PopularAgentIdSchema,
  PopularAgentOverridesSchema,
} from "@archestra/shared";
import { z } from "zod";
import { AgentRuntimeSchema } from "./agent-runtime";

const TemplateEnvironmentSchema = z
  .array(
    z.object({
      key: z
        .string()
        .regex(
          /^[A-Za-z_][A-Za-z0-9_]*$/,
          "Use a valid environment variable name",
        )
        .max(128),
      value: z.string().max(16_384),
    }),
  )
  .max(100)
  .superRefine((entries, ctx) => {
    const keys = new Set<string>();
    for (const [index, entry] of entries.entries()) {
      if (keys.has(entry.key))
        ctx.addIssue({
          code: "custom",
          path: [index, "key"],
          message: "Environment variable names must be unique",
        });
      keys.add(entry.key);
    }
  });

export const AgentRuntimeTemplateSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(1_000),
  icon: z.string().max(700_000).nullable(),
  hidden: z.boolean(),
  position: z.number().int().nonnegative().max(1_000),
  /**
   * Whether this runtime's settings apply to every Agent of its type and only
   * people who can update organization settings may change them there.
   */
  locked: z.boolean().default(false),
  runtime: AgentRuntimeSchema.extend({
    image: z
      .string()
      .trim()
      .min(1)
      .max(2_000)
      .regex(/^\S+$/, "Docker images cannot contain whitespace"),
    command: z.array(z.string().min(1).max(2_000)).max(100).nullable(),
    environment: TemplateEnvironmentSchema.nullable(),
    maxCostUsd: AgentRuntimeSchema.shape.maxCostUsd.nonoptional(),
    // Host access is configured on each Agent, never granted by choosing a template.
    privileged: z.literal(false),
  }),
});
export type AgentRuntimeTemplate = z.infer<typeof AgentRuntimeTemplateSchema>;

/**
 * An administrator's settings for a maintained runtime, over the catalog's
 * own. Its image, wrapper, protocol and follow-up delivery belong to the
 * maintained image and stay as the catalog sets them.
 */
export const BuiltInRuntimeSettingsSchema = AgentRuntimeSchema.pick({
  tier: true,
  maxTier: true,
  ttlHours: true,
  maxCostUsd: true,
  idleTimeoutMinutes: true,
})
  .partial()
  .extend({
    claudeCode: z
      .object({ authentication: z.enum(["provider", "subscription"]) })
      .optional(),
  });

const BuiltInRuntimeSchema = z.object({
  /** Same meaning as a custom runtime's `locked`. */
  locked: z.boolean(),
  settings: BuiltInRuntimeSettingsSchema,
});

export const RuntimeTemplateSettingsSchema = z.object({
  revision: z.number().int().nonnegative(),
  templates: z.array(AgentRuntimeTemplateSchema).max(100),
  builtIns: z
    .partialRecord(PopularAgentIdSchema, BuiltInRuntimeSchema)
    .default({}),
});
export type RuntimeTemplateSettings = z.infer<
  typeof RuntimeTemplateSettingsSchema
>;
export type RuntimeTemplateSettingsInput = z.input<
  typeof RuntimeTemplateSettingsSchema
>;

export const RuntimeTemplateEditorSettingsSchema =
  RuntimeTemplateSettingsSchema.extend({
    popularAgentOverrides: PopularAgentOverridesSchema.nullable(),
  });
export type RuntimeTemplateEditorSettings = z.infer<
  typeof RuntimeTemplateEditorSettingsSchema
>;

export const SaveRuntimeTemplateSettingsSchema =
  RuntimeTemplateEditorSettingsSchema.superRefine(({ templates }, ctx) => {
    const ids = new Set<string>();
    const names = new Set(
      Object.values(AGENT_CATALOG_NAMES).map((name) =>
        name.toLocaleLowerCase(),
      ),
    );
    for (const [index, template] of templates.entries()) {
      if (ids.has(template.id))
        ctx.addIssue({
          code: "custom",
          path: ["templates", index, "id"],
          message: "Template IDs must be unique",
        });
      const name = template.name.toLocaleLowerCase();
      if (names.has(name))
        ctx.addIssue({
          code: "custom",
          path: ["templates", index, "name"],
          message: "Template names must be unique",
        });
      ids.add(template.id);
      names.add(name);
      // An Agent belongs to a custom runtime by its image, so a locked
      // runtime's image must name that runtime alone.
      if (
        template.locked &&
        templates.some(
          (other) =>
            other.id !== template.id &&
            other.runtime.image.trim() === template.runtime.image.trim(),
        )
      )
        ctx.addIssue({
          code: "custom",
          path: ["templates", index, "locked"],
          message:
            "A locked runtime's image can't be shared with another custom runtime",
        });
    }
  });

/** What any agent builder may read about the maintained runtimes. */
export const BuiltInRuntimeSummarySchema = BuiltInRuntimeSchema.extend({
  id: PopularAgentIdSchema,
});

/** Catalog lists never carry environment values or other runtime configuration. */
export const AgentRuntimeTemplateSummarySchema =
  AgentRuntimeTemplateSchema.omit({ runtime: true }).extend({
    image: z.string(),
  });

import {
  AGENT_CATALOG_NAMES,
  AgentRuntimeAccountsSchema,
  AgentRuntimeAccountsViewSchema,
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

/** A runtime's account rule as stored and written: see the shared schema. */
export const RuntimeAccountsSchema = AgentRuntimeAccountsSchema;
export type RuntimeAccounts = z.infer<typeof RuntimeAccountsSchema>;

/** The rule as the API returns it. */
export const RuntimeAccountsViewSchema = AgentRuntimeAccountsViewSchema;
export type RuntimeAccountsView = z.infer<typeof RuntimeAccountsViewSchema>;

export const AgentRuntimeTemplateSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(1_000),
  icon: z.string().max(700_000).nullable(),
  hidden: z.boolean(),
  position: z.number().int().nonnegative().max(1_000),
  // Beside the runtime, not in it: an agent's stored runtime never carries it.
  accounts: RuntimeAccountsSchema.optional(),
  // A runtime-wide account lock is not offered; each agent carries its own.
  runtime: AgentRuntimeSchema.omit({ accountLock: true }).extend({
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
    accounts: RuntimeAccountsSchema.optional(),
  });

const BuiltInRuntimeSchema = z.object({
  settings: BuiltInRuntimeSettingsSchema,
});

/** A custom runtime as the API returns it. */
export const AgentRuntimeTemplateViewSchema = AgentRuntimeTemplateSchema.extend(
  { accounts: RuntimeAccountsViewSchema.optional() },
);

const BuiltInRuntimeViewSchema = z.object({
  settings: BuiltInRuntimeSettingsSchema.extend({
    accounts: RuntimeAccountsViewSchema.optional(),
  }),
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

/**
 * The settings as the API returns them: each runtime's account rule with
 * the names the server fills in.
 */
export const RuntimeTemplateEditorSettingsSchema =
  RuntimeTemplateSettingsSchema.extend({
    templates: z.array(AgentRuntimeTemplateViewSchema).max(100),
    builtIns: z
      .partialRecord(PopularAgentIdSchema, BuiltInRuntimeViewSchema)
      .default({}),
    popularAgentOverrides: PopularAgentOverridesSchema.nullable(),
  });
export type RuntimeTemplateEditorSettings = z.infer<
  typeof RuntimeTemplateEditorSettingsSchema
>;

/**
 * The settings as a save takes them: what is stored, and nothing a read
 * adds. A save that sends a read back has those additions dropped.
 */
export const SaveRuntimeTemplateSettingsSchema =
  RuntimeTemplateSettingsSchema.extend({
    popularAgentOverrides: PopularAgentOverridesSchema.nullable(),
  }).superRefine(({ templates }, ctx) => {
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
    }
  });

/** Which Agent Runtimes the caller may use and configure. */
export const AgentRuntimeAccessSchema = z.object({
  runtimes: z.array(
    z.object({
      /** A built-in runtime's catalog id, or a custom runtime's id. */
      id: z.string(),
      canUse: z.boolean(),
      canConfigure: z.boolean(),
    }),
  ),
  /** Whether the caller may run an image that is none of the runtimes. */
  canConfigureAny: z.boolean(),
});

/** What any agent builder may read about the maintained runtimes. */
export const BuiltInRuntimeSummarySchema = BuiltInRuntimeViewSchema.extend({
  id: PopularAgentIdSchema,
});

/** Catalog lists never carry environment values or other runtime configuration. */
export const AgentRuntimeTemplateSummarySchema =
  AgentRuntimeTemplateViewSchema.omit({ runtime: true }).extend({
    image: z.string(),
  });

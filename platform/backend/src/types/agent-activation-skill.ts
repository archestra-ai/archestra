import { ResourceVisibilityScopeSchema } from "@archestra/shared";
import { z } from "zod";
import { UuidIdSchema } from "./api";

export const AgentActivationSkillReferenceSchema = z
  .discriminatedUnion("source", [
    z.object({
      source: z.literal("native").describe("A skill-library skill."),
      skillId: UuidIdSchema.describe("The skill-library skill ID."),
    }),
    z.object({
      source: z.literal("external_mcp").describe("A skill from an MCP server."),
      mcpServerId: UuidIdSchema.describe("The MCP server installation ID."),
      uri: z.string().describe("The skill resource URI."),
    }),
    z.object({
      source: z.literal("plugin").describe("A skill bundled in a plugin."),
      pluginId: UuidIdSchema.describe("The plugin ID."),
      skillPath: z.string().describe("The skill root inside the plugin."),
    }),
  ])
  .describe(
    "Stable source identity: native uses skillId, external_mcp uses mcpServerId and uri, and plugin uses pluginId and skillPath.",
  );

/**
 * One skill the current principal can activate through an internal agent.
 * `name` is the declared display name; `activationName` is the exact
 * collision-resolved reference accepted by `load_skill`.
 */
export const AgentActivationSkillSchema = z.object({
  reference: AgentActivationSkillReferenceSchema,
  name: z.string().describe("The declared, human-facing skill name."),
  activationName: z.string().describe("The exact name to pass to load_skill."),
  description: z.string().describe("The skill description."),
  scope: ResourceVisibilityScopeSchema.describe(
    "The visibility scope through which the skill is shared.",
  ),
  /** Plugin or MCP server name; null for a native skill-library entry. */
  providerName: z
    .string()
    .nullable()
    .describe("Plugin or MCP server name; null for a skill-library entry."),
});

export const AgentActivationSkillsResponseSchema = z.object({
  enabled: z
    .boolean()
    .describe(
      "Whether load_skill is available for this agent or draft; when false, skills is empty.",
    ),
  skills: z.array(AgentActivationSkillSchema),
});

export type AgentActivationSkill = z.infer<typeof AgentActivationSkillSchema>;
export type AgentActivationSkillsResponse = z.infer<
  typeof AgentActivationSkillsResponseSchema
>;

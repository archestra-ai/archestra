import { z } from "zod";
import { AgentScopeSchema, UpdateAgentSchemaBase, UuidIdSchema } from "@/types";
import {
  AgentDetailOutputSchema,
  CreateBaseToolArgsSchema,
  GetResourceToolArgsSchema,
  handleCreateResource,
  handleEditResource,
  handleGetResource,
  LabelInputSchema,
} from "./agent-resources";
import { defineArchestraTool, defineArchestraTools } from "./helpers";

const CreateLlmProxyToolArgsSchema = CreateBaseToolArgsSchema;

const GetLlmProxyToolArgsSchema = GetResourceToolArgsSchema.extend({
  id: GetResourceToolArgsSchema.shape.id.describe(
    "The ID of the LLM proxy to fetch. Prefer the ID when you already have it.",
  ),
  name: GetResourceToolArgsSchema.shape.name.describe(
    "The exact name of the LLM proxy to fetch when you do not already have the ID.",
  ),
}).refine((data) => data.id || data.name, {
  message: "either id or name parameter is required",
});

const EditLlmProxyToolArgsSchema = z
  .object({
    id: UuidIdSchema.describe(
      "The ID of the LLM proxy to edit. Use get_llm_proxy to look it up by name first if needed.",
    ),
    description: UpdateAgentSchemaBase.shape.description
      .optional()
      .describe("New description for the LLM proxy."),
    icon: UpdateAgentSchemaBase.shape.icon
      .optional()
      .describe("New emoji icon for the LLM proxy."),
    labels: z
      .array(LabelInputSchema)
      .optional()
      .describe("Replace the LLM proxy's labels with this set."),
    name: UpdateAgentSchemaBase.shape.name
      .optional()
      .describe("New name for the LLM proxy."),
    scope: AgentScopeSchema.optional().describe(
      "Updated visibility scope for the LLM proxy.",
    ),
    teams: z
      .array(UuidIdSchema)
      .optional()
      .describe("Replace the teams attached to a team-scoped LLM proxy."),
  })
  .strict();

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: "create_llm_proxy",
    title: "Create LLM Proxy",
    description:
      "Create a new LLM proxy with the specified name and optional labels.",
    schema: CreateLlmProxyToolArgsSchema,
    async handler({ args, context }) {
      return handleCreateResource({
        args,
        context,
        targetAgentType: "llm_proxy",
      });
    },
  }),
  defineArchestraTool({
    shortName: "get_llm_proxy",
    title: "Get LLM Proxy",
    description:
      "Get a specific LLM proxy by ID or name. When searching by name, only your personal proxies are matched.",
    schema: GetLlmProxyToolArgsSchema,
    outputSchema: AgentDetailOutputSchema,
    async handler({ args, context }) {
      return handleGetResource({
        args,
        context,
        expectedType: "llm_proxy",
        getLabel: "llm proxy",
      });
    },
  }),
  defineArchestraTool({
    shortName: "edit_llm_proxy",
    title: "Edit LLM Proxy",
    description:
      "Edit an existing LLM proxy. All fields are optional except id. Only provided fields are updated, and the tool respects the calling user's access level.",
    schema: EditLlmProxyToolArgsSchema,
    async handler({ args, context }) {
      return handleEditResource({
        args,
        context,
        expectedType: "llm_proxy",
      });
    },
  }),
] as const);

export const toolShortNames = registry.toolShortNames;
export const toolArgsSchemas = registry.toolArgsSchemas;
export const toolOutputSchemas = registry.toolOutputSchemas;
export const toolEntries = registry.toolEntries;
export const tools = registry.tools;

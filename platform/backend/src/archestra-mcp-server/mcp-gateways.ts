import {
  TOOL_CREATE_MCP_GATEWAY_SHORT_NAME,
  TOOL_EDIT_MCP_GATEWAY_SHORT_NAME,
  TOOL_GET_MCP_GATEWAY_SHORT_NAME,
} from "@shared";
import { z } from "zod";
import {
  AgentScopeSchema,
  ToolAssignmentModeSchema,
  ToolExposureModeSchema,
  UpdateAgentSchemaBase,
  UuidIdSchema,
} from "@/types";
import {
  AgentDetailOutputSchema,
  ConnectorIdsToolInputSchema,
  CreateBaseToolArgsSchema,
  GetResourceToolArgsSchema,
  handleCreateResource,
  handleEditResource,
  handleGetResource,
  KnowledgeBaseIdsToolInputSchema,
  LabelInputSchema,
} from "./agent-resources";
import { defineArchestraTool, defineArchestraTools } from "./helpers";

const CreateMcpGatewayToolArgsSchema = CreateBaseToolArgsSchema.extend({
  knowledgeBaseIds: KnowledgeBaseIdsToolInputSchema.optional(),
  connectorIds: ConnectorIdsToolInputSchema.optional(),
  toolAssignmentMode: ToolAssignmentModeSchema.optional().describe(
    "How tools are assigned to this gateway. 'manual' (default) lets an admin pick tools individually. 'automatic' derives the gateway's tools from catalog entries whose labels match the gateway's labels (key-value pairs, OR semantics).",
  ),
}).strict();

const GetMcpGatewayToolArgsSchema = GetResourceToolArgsSchema.extend({
  id: GetResourceToolArgsSchema.shape.id.describe(
    "The ID of the MCP gateway to fetch. Prefer the ID when you already have it.",
  ),
  name: GetResourceToolArgsSchema.shape.name.describe(
    "The exact name of the MCP gateway to fetch when you do not already have the ID.",
  ),
}).refine((data) => data.id || data.name, {
  message: "either id or name parameter is required",
});

const EditMcpGatewayToolArgsSchema = z
  .object({
    id: UuidIdSchema.describe(
      "The ID of the MCP gateway to edit. Use get_mcp_gateway to look it up by name first if needed.",
    ),
    description: UpdateAgentSchemaBase.shape.description
      .optional()
      .describe("New description for the MCP gateway."),
    icon: UpdateAgentSchemaBase.shape.icon
      .optional()
      .describe("New emoji icon for the MCP gateway."),
    labels: z
      .array(LabelInputSchema)
      .optional()
      .describe("Replace the MCP gateway's labels with this set."),
    name: UpdateAgentSchemaBase.shape.name
      .optional()
      .describe("New name for the MCP gateway."),
    scope: AgentScopeSchema.optional().describe(
      "Updated visibility scope for the MCP gateway.",
    ),
    toolExposureMode: ToolExposureModeSchema.optional().describe(
      "How tools should be exposed to MCP clients and models.",
    ),
    toolAssignmentMode: ToolAssignmentModeSchema.optional().describe(
      "How tools are assigned to this gateway. 'manual' lets an admin pick tools individually. 'automatic' derives the gateway's tools from catalog entries whose labels match the gateway's labels (key-value pairs, OR semantics).",
    ),
    teams: z
      .array(UuidIdSchema)
      .optional()
      .describe("Replace the teams attached to a team-scoped MCP gateway."),
    knowledgeBaseIds: UpdateAgentSchemaBase.shape.knowledgeBaseIds
      .describe(
        "Replace the MCP gateway's assigned knowledge bases with this set.",
      )
      .optional(),
    connectorIds: UpdateAgentSchemaBase.shape.connectorIds
      .describe(
        "Replace the MCP gateway's directly assigned knowledge connectors with this set.",
      )
      .optional(),
  })
  .strict();

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: TOOL_CREATE_MCP_GATEWAY_SHORT_NAME,
    title: "Create MCP Gateway",
    description:
      "Create a new MCP gateway with the specified name, optional labels, and optional assigned knowledge bases or knowledge connectors.",
    schema: CreateMcpGatewayToolArgsSchema,
    async handler({ args, context }) {
      return handleCreateResource({
        args,
        context,
        targetAgentType: "mcp_gateway",
      });
    },
  }),
  defineArchestraTool({
    shortName: TOOL_GET_MCP_GATEWAY_SHORT_NAME,
    title: "Get MCP Gateway",
    description:
      "Get a specific MCP gateway by ID or name. When searching by name, only your personal gateways are matched.",
    schema: GetMcpGatewayToolArgsSchema,
    outputSchema: AgentDetailOutputSchema,
    async handler({ args, context }) {
      return handleGetResource({
        args,
        context,
        expectedType: "mcp_gateway",
        getLabel: "mcp gateway",
      });
    },
  }),
  defineArchestraTool({
    shortName: TOOL_EDIT_MCP_GATEWAY_SHORT_NAME,
    title: "Edit MCP Gateway",
    description:
      "Edit an existing MCP gateway. All fields are optional except id. Only provided fields are updated, and the tool respects the calling user's access level, including knowledge source assignments.",
    schema: EditMcpGatewayToolArgsSchema,
    async handler({ args, context }) {
      return handleEditResource({
        args,
        context,
        expectedType: "mcp_gateway",
      });
    },
  }),
] as const);

export const toolShortNames = registry.toolShortNames;
export const toolArgsSchemas = registry.toolArgsSchemas;
export const toolOutputSchemas = registry.toolOutputSchemas;
export const toolEntries = registry.toolEntries;
export const tools = registry.tools;

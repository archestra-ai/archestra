import {
  AGENT_CATALOG_IDS,
  AGENT_CATALOG_NAMES,
  type AgentCatalogId,
  buildAgentCatalogRuntime,
  buildAgentCatalogSystemPrompt,
  buildCustomAgentRuntime,
  isIntegrationHidden,
  type ResourcePermissionGrant,
  ResourcePermissionGrantSchema,
  resolveAgentCatalogId,
  TOOL_LIST_AGENTS_SHORT_NAME,
  TOOL_LIST_LLM_MODELS_SHORT_NAME,
  TOOL_LOAD_SKILL_SHORT_NAME,
  TOOL_TRANSFER_CREDENTIAL_SHORT_NAME,
} from "@archestra/shared";
import { z } from "zod";
import { slackAppFactory } from "@/agents/chatops/slack-app-factory";
import {
  getAgentTypePermissionChecker,
  isAgentTypeAdmin,
  requireAgentModifyPermission,
} from "@/auth/agent-type-permissions";
import { getSkillPermissionChecker } from "@/auth/skill-permissions";
import config from "@/config";
import { knowledgeSourceAccessControlService } from "@/knowledge-base/source-access-control";
import logger from "@/logging";
import {
  AgentModel,
  KnowledgeBaseConnectorModel,
  KnowledgeBaseModel,
  OrganizationModel,
} from "@/models";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { getAgentActivationSkills } from "@/services/agent-activation-skills";
import {
  assertAgentModelSelectionAvailable,
  assertAgentRuntimeModelCompatibility,
  requireAgentRuntimePermission,
} from "@/services/agent-runtime/agent-config-validation";
import { resolveDefaultEnvironmentForNewResource } from "@/services/environments/environment";
import { ResourcePermissions } from "@/services/resource-permissions";
import { SKILL_CATALOG_UNTRUSTED_NOTE } from "@/skills/skill-catalog-prompt";
import type { Agent, AgentRuntime, ToolExposureMode } from "@/types";
import {
  AgentActivationSkillSchema,
  AgentRuntimeSchema,
  AgentScopeSchema,
  AgentToolAssignmentInputSchema,
  ApiError,
  InsertAgentSchemaBase,
  LabelWithDetailsSchema,
  SuggestedPromptInputSchema,
  ToolExposureModeSchema,
  UuidIdSchema,
} from "@/types";
import { archestraMcpBranding } from "./branding";
import { isArchestraToolAvailableToAgent } from "./dynamic-tools";
import {
  assignSubAgentDelegations,
  assignToolAssignments,
  catchError,
  deduplicateLabels,
  errorResult,
  formatAssignmentSummary,
  structuredSuccessResult,
  successResult,
  type ToolAssignmentInput,
} from "./helpers";
import type { ArchestraContext } from "./types";

// === Shared schemas ===

export const LabelInputSchema = LabelWithDetailsSchema.pick({
  key: true,
  value: true,
})
  .strict()
  .describe("Key-value labels for organization/categorization.");

export const SuggestedPromptToolInputSchema = SuggestedPromptInputSchema.extend(
  {
    summaryTitle: SuggestedPromptInputSchema.shape.summaryTitle.describe(
      "Short title shown to users for this suggested prompt.",
    ),
    prompt: SuggestedPromptInputSchema.shape.prompt.describe(
      "Suggested prompt text users can click to start a conversation.",
    ),
  },
).strict();

export const ToolAssignmentToolInputSchema =
  AgentToolAssignmentInputSchema.extend({
    toolId: AgentToolAssignmentInputSchema.shape.toolId.describe(
      "The ID of the tool to assign to the agent.",
    ),
    resolveAtCallTime:
      AgentToolAssignmentInputSchema.shape.resolveAtCallTime.describe(
        "When true, resolve credentials and execution target at tool call time. Prefer this for builder flows.",
      ),
    mcpServerId: AgentToolAssignmentInputSchema.shape.mcpServerId.describe(
      "Optional MCP server installation to pin the tool to when using static credential resolution.",
    ),
  }).strict();

export const KnowledgeBaseIdsToolInputSchema =
  InsertAgentSchemaBase.shape.knowledgeBaseIds.describe(
    "Knowledge base IDs to assign to the agent. Use get_knowledge_bases first when you need to look up IDs by name.",
  );

export const ConnectorIdsToolInputSchema =
  InsertAgentSchemaBase.shape.connectorIds.describe(
    "Knowledge connector IDs to assign directly to the agent. Use get_knowledge_connectors first when you need to look up IDs by name.",
  );

export const CreateBaseToolArgsSchema = z
  .object({
    initialGrants: z.array(ResourcePermissionGrantSchema).max(200).optional(),
    name: InsertAgentSchemaBase.shape.name.describe(
      "Name for the new resource.",
    ),
    labels: z
      .array(LabelInputSchema)
      .optional()
      .describe(
        "Optional key-value labels for organization and categorization.",
      ),
    toolExposureMode: ToolExposureModeSchema.optional().describe(
      "How tools should be loaded for MCP clients and models. Use 'search_and_run_only' to keep the initial tool list small while letting search_tools find assigned tools and run_tool execute them. Assigned skill discovery/loading tools (list_skills, load_skill), sandbox runtime tools (run_command, download_file, upload_file) — when the code runtime is enabled and assigned — and persistent-files tools (search_files, read_file, save_file, edit_file, delete_file) — when the Projects feature is enabled and assigned — stay directly available in both modes. App tools (scaffold_app, edit_app, read_app, render_app, list_apps, and the rest of the app surface) are reached through search_tools/run_tool in 'search_and_run_only' mode.",
    ),
    accessAllTools: z
      .boolean()
      .optional()
      .describe(
        "Allow dynamic tool access: search_tools/run_tool may discover and run any tool the calling user can access (MCP catalog tools and knowledge sources) without assigning it to the agent. Enabling this forces toolExposureMode to 'search_and_run_only', since dynamic access only works through the search/run dispatch surface. Defaults to false. Also gated by the organization's security settings.",
      ),
    accessAllSubagents: z
      .boolean()
      .optional()
      .describe(
        "Allow dynamic subagent delegation: the agent may delegate to any internal agent the calling user can access, beyond explicitly-configured delegation targets (minus subagent exclusions). Defaults to false.",
      ),
  })
  .strict();

/**
 * An Agent Runtime, as the agent create and edit pages offer it: one of the
 * maintained CLI templates (the catalog cards), or a custom image. Fields left
 * out take the value the page would start from.
 */
export const AgentRuntimeToolInputSchema = z
  .union([
    AgentRuntimeSchema.omit({
      image: true,
      command: true,
      inferenceProtocol: true,
    })
      .partial()
      .extend({
        template: z
          .enum(AGENT_CATALOG_IDS as [AgentCatalogId, ...AgentCatalogId[]])
          .describe(
            `Maintained CLI to run: ${AGENT_CATALOG_IDS.map((id) => `'${id}' (${AGENT_CATALOG_NAMES[id]})`).join(", ")}. The image, launch command, and model protocol come from the template.`,
          ),
      })
      .strict(),
    AgentRuntimeSchema.partial()
      .required({ image: true })
      .strict()
      .describe(
        "A custom container image. Set inferenceProtocol to the wire protocol the image speaks to the model router.",
      ),
  ])
  .describe(
    "Run this agent in its own container (Agent Runtime) instead of the built-in chat harness. " +
      "Pass { template } for a maintained CLI, or { image } for a custom image. Other fields override the defaults: " +
      "claudeCode.authentication is 'subscription' (each user signs in with their own Claude account, the default) or 'provider' (bill through llmApiKeyId/modelId); " +
      "credentials declares environment variables a run needs (users supply values later, or use " +
      `${TOOL_TRANSFER_CREDENTIAL_SHORT_NAME}); ttlHours, idleTimeoutMinutes, and maxCostUsd bound each run; privileged requires an agent administrator.`,
  );

type AgentRuntimeToolInput = z.infer<typeof AgentRuntimeToolInputSchema>;

export const AgentModelToolInputSchemas = {
  llmApiKeyId: UuidIdSchema.describe(
    `Provider API key the agent uses. Set together with modelId. Use ${TOOL_LIST_LLM_MODELS_SHORT_NAME} to find both.`,
  ),
  modelId: UuidIdSchema.describe(
    `Model the agent uses: the model's id from ${TOOL_LIST_LLM_MODELS_SHORT_NAME}, not its provider name. Set together with llmApiKeyId.`,
  ),
};

export const GetResourceToolArgsSchema = z
  .object({
    id: UuidIdSchema.optional(),
    name: z.string().trim().min(1).optional(),
  })
  .strict();

const AgentToolOutputSchema = z.object({
  id: z.string().describe("The assigned tool ID."),
  name: z.string().describe("The tool name."),
  description: z.string().nullable().describe("The tool description, if any."),
  catalogId: z
    .string()
    .nullable()
    .describe("The MCP catalog ID the tool comes from, if any."),
});

export const AgentTeamOutputSchema = z.object({
  id: z.string().describe("The team ID."),
  name: z.string().describe("The team name."),
});

export const AgentLabelOutputSchema = z.object({
  key: z.string().describe("The label key."),
  value: z.string().describe("The label value."),
});

const AgentSuggestedPromptOutputSchema = z.object({
  summaryTitle: z.string().describe("The short title shown in the chat UI."),
  prompt: z.string().describe("The suggested prompt text."),
});

const ResourceDetailOutputSchema = z.object({
  id: z.string().describe("The resource ID."),
  name: z.string().describe("The resource name."),
  description: z
    .string()
    .nullable()
    .describe("The resource description, if any."),
  icon: z.string().nullable().describe("The emoji icon, if configured."),
  scope: AgentScopeSchema.describe("The visibility scope."),
  toolExposureMode: ToolExposureModeSchema.describe(
    "How tools are loaded for MCP clients and models.",
  ),
  accessAllTools: z
    .boolean()
    .describe(
      "Whether search_tools/run_tool may dynamically access every tool the calling user can access.",
    ),
  accessAllSubagents: z
    .boolean()
    .describe(
      "Whether the agent may delegate to every internal agent the calling user can access.",
    ),
  agentType: z
    .enum(["agent", "llm_proxy", "mcp_gateway", "profile"])
    .describe("The resource type."),
  systemPrompt: z.string().nullable().optional(),
  teams: z.array(AgentTeamOutputSchema).describe("The teams attached to it."),
  labels: z.array(AgentLabelOutputSchema).describe("Assigned labels."),
  tools: z.array(AgentToolOutputSchema).describe("Assigned tools."),
  knowledgeBaseIds: z
    .array(z.string())
    .describe("Assigned knowledge base IDs."),
  connectorIds: z
    .array(z.string())
    .describe("Assigned knowledge connector IDs."),
  suggestedPrompts: z
    .array(AgentSuggestedPromptOutputSchema)
    .describe("Configured suggested prompts."),
});

export const McpGatewayDetailOutputSchema = ResourceDetailOutputSchema;

export const AgentDetailOutputSchema = ResourceDetailOutputSchema.extend({
  runtime: AgentRuntimeSchema.nullable()
    .optional()
    .describe(
      "The Agent Runtime container this agent runs in, or null for the built-in chat harness.",
    ),
  llmApiKeyId: z
    .string()
    .nullable()
    .optional()
    .describe("The pinned provider API key ID, or null for the default."),
  modelId: z
    .string()
    .nullable()
    .optional()
    .describe("The pinned model ID, or null for the default."),
  skillsEnabled: z
    .boolean()
    .optional()
    .describe(
      "Present for an internal agent when the current user has skill:read; whether load_skill is executable for it.",
    ),
  skillsNotice: z
    .string()
    .optional()
    .describe(
      "Trust boundary for the catalog-supplied skill names and descriptions in skills.",
    ),
  skills: z
    .array(AgentActivationSkillSchema)
    .optional()
    .describe(
      "Present for an internal agent when the current user has skill:read; caller-relative skills it can activate.",
    ),
});

export const KnowledgeSourceOutputSchema = z.object({
  name: z.string().describe("The knowledge source name."),
  description: z
    .string()
    .nullable()
    .describe("The knowledge source description, if any."),
  type: z
    .enum(["knowledge_base", "knowledge_connector"])
    .describe("Whether this source is a knowledge base or connector."),
});

// === Exports ===

/**
 * Where a record's edit page lives, per family. Every family used to be linked
 * as `/agents?edit=<id>`: a link only the internal-agent list could resolve, so
 * an MCP gateway sent the reader to a page that does not know the
 * id. Each family now has its own routed edit page.
 */
const EDIT_PATH_BUILDERS: Record<
  "agent" | "mcp_gateway",
  (id: string) => string
> = {
  agent: (id) => `/agents/${id}/edit`,
  mcp_gateway: (id) => `/mcp/gateways/${id}/edit`,
};

function buildEditLink(agentType: "agent" | "mcp_gateway", id: string): string {
  return `${config.frontendBaseUrl}${EDIT_PATH_BUILDERS[agentType](id)}`;
}

export async function handleCreateResource<
  TArgs extends {
    name: string;
    initialGrants?: ResourcePermissionGrant[];
    labels?: Array<{ key: string; value: string }>;
    description?: string | null;
    icon?: string | null;
    knowledgeBaseIds?: string[];
    connectorIds?: string[];
    systemPrompt?: string | null;
    suggestedPrompts?: Array<{ summaryTitle: string; prompt: string }>;
    subAgentIds?: string[];
    toolAssignments?: ToolAssignmentInput[];
    toolExposureMode?: ToolExposureMode;
    accessAllTools?: boolean;
    accessAllSubagents?: boolean;
    runtime?: AgentRuntimeToolInput;
    llmApiKeyId?: string;
    modelId?: string;
  },
>(params: {
  args: TArgs;
  context: ArchestraContext;
  targetAgentType: "agent" | "mcp_gateway";
}) {
  const { args, context, targetAgentType } = params;
  const toolLabel = targetAgentType.replace("_", " ");

  logger.info(
    {
      agentId: context.agent.id,
      createArgs: args,
      agentType: targetAgentType,
    },
    `create_${targetAgentType} tool called`,
  );

  try {
    const labels = args.labels ? deduplicateLabels(args.labels) : undefined;

    if (!args.name || args.name.trim() === "") {
      return errorResult(`${toolLabel} name is required and cannot be empty.`);
    }

    let isAgentAdmin = false;
    if (context.userId && context.organizationId) {
      const checker = await getAgentTypePermissionChecker({
        userId: context.userId,
        organizationId: context.organizationId,
      });
      checker.require(targetAgentType, "create");
      isAgentAdmin = checker.isAdmin(targetAgentType);
    }

    const runtimeAndModel = await resolveRuntimeAndModelForWrite({
      context,
      agentType: targetAgentType,
      isAgentAdmin,
      runtimeInput: args.runtime,
      llmApiKeyId: args.llmApiKeyId,
      modelId: args.modelId,
      existing: null,
    });

    const createParams: Parameters<typeof AgentModel.create>[0] = {
      name: args.name,
      // The retired visibility column is NOT NULL; nothing reads it. Who can
      // reach the agent is its initial grants alone.
      scope: "personal",
      labels,
      agentType: targetAgentType,
      environmentId: await resolveNewAgentEnvironmentId({
        context,
        agentType: targetAgentType,
      }),
    };
    if (args.toolExposureMode !== undefined) {
      createParams.toolExposureMode = args.toolExposureMode;
    }
    if (args.accessAllTools !== undefined) {
      createParams.accessAllTools = args.accessAllTools;
    }
    if (args.accessAllSubagents !== undefined) {
      createParams.accessAllSubagents = args.accessAllSubagents;
    }
    Object.assign(createParams, runtimeAndModel);

    // A template-backed agent starts with what the catalog card would give
    // it: a coding-agent prompt and dynamic tool access.
    const template =
      args.runtime && "template" in args.runtime ? args.runtime.template : null;
    if (template && args.accessAllTools === undefined) {
      createParams.accessAllTools = true;
    }

    if (targetAgentType === "agent" || targetAgentType === "mcp_gateway") {
      if (targetAgentType === "agent" && args.systemPrompt) {
        createParams.systemPrompt = args.systemPrompt;
      } else if (targetAgentType === "agent" && template) {
        createParams.systemPrompt = buildAgentCatalogSystemPrompt({
          name: AGENT_CATALOG_NAMES[template],
          platformName: archestraMcpBranding.appName,
        });
      }
      if (args.description) createParams.description = args.description;
      if (args.icon) createParams.icon = args.icon;
      if (targetAgentType === "agent" && args.suggestedPrompts) {
        createParams.suggestedPrompts = args.suggestedPrompts;
      }
      if (
        args.knowledgeBaseIds !== undefined ||
        args.connectorIds !== undefined
      ) {
        await validateKnowledgeAssignments({
          userId: context.userId,
          organizationId: context.organizationId,
          knowledgeBaseIds: args.knowledgeBaseIds,
          connectorIds: args.connectorIds,
        });
      }
      if (args.knowledgeBaseIds) {
        createParams.knowledgeBaseIds = args.knowledgeBaseIds;
      }
      if (args.connectorIds) {
        createParams.connectorIds = args.connectorIds;
      }
    } else {
      if (args.description) createParams.description = args.description;
      if (args.icon) createParams.icon = args.icon;
    }

    if (args.initialGrants !== undefined) {
      if (!context.userId || !context.organizationId)
        return errorResult(
          "User and organization context are required to assign grants.",
        );
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      await ResourcePermissions.validateInitialGrants({
        organizationId: context.organizationId,
        userId: context.userId,
        resource: targetAgentType === "mcp_gateway" ? "mcpGateway" : "agent",
        grants: args.initialGrants,
        target: {
          id: crypto.randomUUID(),
          name: args.name,
          authorId: context.userId,
        },
      });
      // SPDX-SnippetEnd
    }
    const created = await AgentModel.create(createParams, context.userId, {
      initialPermissionGrants: args.initialGrants ?? [],
    });

    const toolAssignmentResults =
      targetAgentType === "agent" && (args.toolAssignments?.length ?? 0) > 0
        ? await assignToolAssignments(created.id, args.toolAssignments ?? [])
        : [];
    const subAgentResults =
      targetAgentType === "agent" && (args.subAgentIds?.length ?? 0) > 0
        ? await assignSubAgentDelegations(created.id, args.subAgentIds ?? [])
        : [];

    const editLink = buildEditLink(targetAgentType, created.id);
    const lines = [
      `Successfully created ${toolLabel}.`,
      "",
      `Name: ${created.name}`,
      `ID: ${created.id}`,
      `Type: ${targetAgentType}`,
      `Runtime: ${describeRuntime(created.runtime)}`,
      `Edit: ${editLink}`,
      `Teams: ${created.teams.length > 0 ? created.teams.map((team) => team.name).join(", ") : "None"}`,
      `Labels: ${created.labels.length > 0 ? created.labels.map((label) => `${label.key}: ${label.value}`).join(", ") : "None"}`,
    ];
    formatAssignmentSummary(lines, subAgentResults, toolAssignmentResults);

    return successResult(lines.join("\n"));
  } catch (error) {
    if (error instanceof ApiError) return errorResult(error.message);
    return catchError(error, `creating ${toolLabel}`);
  }
}

export async function handleGetResource<
  TArgs extends { id?: string; name?: string },
>(params: {
  args: TArgs;
  context: ArchestraContext;
  expectedType: "agent" | "mcp_gateway";
  getLabel: string;
}) {
  const { args, context, expectedType, getLabel } = params;

  logger.info(
    {
      agentId: context.agent.id,
      requestedId: args.id,
      requestedName: args.name,
      type: expectedType,
    },
    `get_${expectedType} tool called`,
  );

  try {
    if (!args.id && !args.name) {
      return errorResult("either id or name parameter is required");
    }

    let record: Agent | null | undefined;

    const isAdmin =
      context.userId && context.organizationId
        ? await isAgentTypeAdmin({
            userId: context.userId,
            organizationId: context.organizationId,
            agentType: expectedType,
          })
        : false;

    const checker =
      context.userId && context.organizationId
        ? await getAgentTypePermissionChecker({
            userId: context.userId,
            organizationId: context.organizationId,
          })
        : null;

    if (args.id) {
      record = await AgentModel.findById(args.id, context.userId, isAdmin);
      // findById doesn't support excludeOtherPersonalAgents, so we guard here.
      // MCP tools only need the caller's own personal agents to be visible,
      // even though admins can see all personal agents in the UI.
      if (
        record &&
        context.userId &&
        record.authorId !== context.userId &&
        // SPDX-SnippetBegin
        // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
        // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
        (
          await ResourcePermissionPolicyModel.findAudience({
            organizationId: record.organizationId,
            resource:
              record.agentType === "mcp_gateway" ? "mcpGateway" : "agent",
            scope: record.id,
          })
        ).audience === "personal" &&
        // SPDX-SnippetEnd
        !checker?.allowsScoped?.({
          agentType: expectedType,
          agentId: record.id,
          action: "read",
        })
      ) {
        record = null;
      }
    } else if (args.name) {
      const results = await AgentModel.findAllPaginated(
        { limit: 1, offset: 0 },
        undefined,
        {
          organizationId: context.organizationId,
          name: args.name,
          agentType: expectedType,
          ...(checker && context.organizationId
            ? {
                authorization: {
                  organizationId: context.organizationId,
                  baseReadTypes: checker.hasBaseAction?.(expectedType, "read")
                    ? [expectedType]
                    : [],
                },
              }
            : {}),
          // Hide other users' personal agents from MCP tools. Only the
          // caller's own personal agents need to be visible, even though
          // admins can see all personal agents in the UI.
          excludeOtherPersonalAgents: true,
        },
        context.userId,
        isAdmin,
      );

      if (results.data.length > 0) {
        record = results.data[0];
      }
    }

    if (
      record &&
      (!context.organizationId ||
        record.organizationId !== context.organizationId)
    ) {
      record = null;
    }

    if (!record) {
      // only agents have a discovery tool; proxies/gateways have no list tool.
      const steer =
        expectedType === "agent"
          ? ` Call ${archestraMcpBranding.getToolName(TOOL_LIST_AGENTS_SHORT_NAME)} to find the exact id or name.`
          : "";
      return errorResult(`${getLabel} not found.${steer}`);
    }

    if (record.agentType !== expectedType) {
      return errorResult(
        `The requested entity is a ${record.agentType}, not a ${expectedType}.`,
      );
    }

    if (context.userId && context.organizationId) {
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      await ResourcePermissions.require({
        organizationId: context.organizationId,
        userId: context.userId,
        resource: expectedType === "agent" ? "agent" : "mcpGateway",
        scope: record.id,
        action: "read",
      });
      // SPDX-SnippetEnd
    }
    const canReadSkills =
      expectedType === "agent" && context.organizationId && context.userId
        ? (
            await getSkillPermissionChecker({
              organizationId: context.organizationId,
              userId: context.userId,
            })
          ).canRead
        : false;
    if (expectedType === "agent" && context.organizationId && canReadSkills) {
      const activationSkills = await getAgentActivationSkills({
        enabled: await isArchestraToolAvailableToAgent({
          toolName: archestraMcpBranding.getToolName(
            TOOL_LOAD_SKILL_SHORT_NAME,
          ),
          agentId: record.id,
          organizationId: context.organizationId,
          userId: context.userId,
        }),
        organizationId: context.organizationId,
        userId: context.userId,
        agentId: record.id,
      });
      const agentWithSkills = {
        ...record,
        skillsEnabled: activationSkills.enabled,
        skillsNotice: SKILL_CATALOG_UNTRUSTED_NOTE,
        skills: activationSkills.skills,
      };
      return structuredSuccessResult(
        agentWithSkills,
        JSON.stringify(agentWithSkills, null, 2),
      );
    }

    return structuredSuccessResult(record, JSON.stringify(record, null, 2));
  } catch (error) {
    return catchError(error, `getting ${getLabel}`);
  }
}

export async function handleEditResource<
  TArgs extends {
    id: string;
    name?: string;
    description?: string | null;
    icon?: string | null;
    labels?: Array<{ key: string; value: string }>;
    knowledgeBaseIds?: string[];
    connectorIds?: string[];
    systemPrompt?: string | null;
    suggestedPrompts?: Array<{ summaryTitle: string; prompt: string }>;
    subAgentIds?: string[];
    toolAssignments?: ToolAssignmentInput[];
    toolExposureMode?: ToolExposureMode;
    accessAllTools?: boolean;
    accessAllSubagents?: boolean;
    runtime?: AgentRuntimeToolInput | null;
    llmApiKeyId?: string | null;
    modelId?: string | null;
  },
>(params: {
  args: TArgs;
  context: ArchestraContext;
  expectedType: "agent" | "mcp_gateway";
}) {
  const { args, context, expectedType } = params;
  const toolLabel = expectedType.replace("_", " ");

  logger.info(
    { agentId: context.agent.id, editArgs: args, agentType: expectedType },
    `edit_${expectedType} tool called`,
  );

  try {
    if (!context.userId || !context.organizationId) {
      return errorResult("user/organization context not available.");
    }

    const existingAgent = await AgentModel.findById(args.id);
    if (
      !existingAgent ||
      existingAgent.organizationId !== context.organizationId
    ) {
      return errorResult(`${toolLabel} not found.`);
    }

    if (existingAgent.agentType !== expectedType) {
      return errorResult(
        `this tool only edits ${toolLabel}s, not ${existingAgent.agentType}.`,
      );
    }

    const checker = await getAgentTypePermissionChecker({
      userId: context.userId,
      organizationId: context.organizationId,
    });
    checker.require(existingAgent.agentType, {
      action: "update",
      scope: existingAgent.id,
    });

    // Who can reach the record is not editable here: access lives in its
    // permission policy, which the resource permissions API writes on its own.
    requireAgentModifyPermission({
      agentId: existingAgent.id,
      action: "update",
      checker,
      agentType: existingAgent.agentType,
    });

    const runtimeAndModel = await resolveRuntimeAndModelForWrite({
      context,
      agentType: existingAgent.agentType,
      isAgentAdmin: checker.isAdmin(existingAgent.agentType),
      runtimeInput: args.runtime,
      llmApiKeyId: args.llmApiKeyId,
      modelId: args.modelId,
      existing: existingAgent,
    });

    const updateData: Record<string, unknown> = { ...runtimeAndModel };
    if (args.name !== undefined) updateData.name = args.name;
    if (args.description !== undefined)
      updateData.description = args.description;
    if (args.icon !== undefined) updateData.icon = args.icon;
    if (args.toolExposureMode !== undefined) {
      updateData.toolExposureMode = args.toolExposureMode;
    }
    if (args.accessAllTools !== undefined) {
      updateData.accessAllTools = args.accessAllTools;
    }
    if (args.accessAllSubagents !== undefined) {
      updateData.accessAllSubagents = args.accessAllSubagents;
    }
    if (args.labels !== undefined) {
      updateData.labels = deduplicateLabels(args.labels);
    }

    if (expectedType === "agent" || expectedType === "mcp_gateway") {
      if (expectedType === "agent" && args.systemPrompt !== undefined) {
        updateData.systemPrompt = args.systemPrompt;
      }
      if (expectedType === "agent" && args.suggestedPrompts !== undefined) {
        updateData.suggestedPrompts = args.suggestedPrompts;
      }
      if (
        args.knowledgeBaseIds !== undefined ||
        args.connectorIds !== undefined
      ) {
        await validateKnowledgeAssignments({
          userId: context.userId,
          organizationId: context.organizationId,
          knowledgeBaseIds: args.knowledgeBaseIds,
          connectorIds: args.connectorIds,
        });
      }
      if (args.knowledgeBaseIds !== undefined) {
        updateData.knowledgeBaseIds = args.knowledgeBaseIds;
      }
      if (args.connectorIds !== undefined) {
        updateData.connectorIds = args.connectorIds;
      }
    }

    const updated = await AgentModel.update(
      args.id,
      updateData as Parameters<typeof AgentModel.update>[1],
    );

    if (!updated) {
      return errorResult(`failed to update ${toolLabel}.`);
    }
    // A Slack bot of this agent follows its name and icon (best effort).
    void slackAppFactory.syncAgentIdentity(args.id);

    const toolAssignmentResults =
      expectedType === "agent" && (args.toolAssignments?.length ?? 0) > 0
        ? await assignToolAssignments(args.id, args.toolAssignments ?? [])
        : [];
    const subAgentResults =
      expectedType === "agent" && (args.subAgentIds?.length ?? 0) > 0
        ? await assignSubAgentDelegations(args.id, args.subAgentIds ?? [])
        : [];

    const editLink = buildEditLink(expectedType, updated.id);
    const lines = [
      `Successfully updated ${toolLabel}.`,
      "",
      `Name: ${updated.name}`,
      `ID: ${updated.id}`,
      `Runtime: ${describeRuntime(updated.runtime)}`,
      `Edit: ${editLink}`,
      `Scope: ${updated.scope}`,
      `Teams: ${updated.teams.length > 0 ? updated.teams.map((team) => team.name).join(", ") : "None"}`,
      `Labels: ${updated.labels.length > 0 ? updated.labels.map((label) => `${label.key}: ${label.value}`).join(", ") : "None"}`,
    ];
    formatAssignmentSummary(lines, subAgentResults, toolAssignmentResults);

    return successResult(lines.join("\n"));
  } catch (error) {
    if (error instanceof ApiError) return errorResult(error.message);
    return catchError(error, `editing ${toolLabel}`);
  }
}

/**
 * These tools take no environment, so a new agent lands wherever the org says
 * new agents of its type go (the Default environment until an admin configures
 * otherwise). A restricted target the caller may not deploy to resolves back to
 * Default rather than failing the create.
 */
async function resolveNewAgentEnvironmentId(params: {
  context: ArchestraContext;
  agentType: "agent" | "mcp_gateway";
}): Promise<string | null> {
  const { context, agentType } = params;
  const { userId, organizationId } = context;
  if (!userId || !organizationId) return null;

  const resource = agentType === "mcp_gateway" ? "mcpGateway" : "agent";
  return resolveDefaultEnvironmentForNewResource({
    organizationId,
    resource,
    userId,
  });
}

/**
 * Validate a runtime and model change the way the agents REST routes do, and
 * return only the fields to write. `existing` is the stored agent on an edit,
 * so a change to one field is checked against the other's current value.
 */
async function resolveRuntimeAndModelForWrite(params: {
  context: ArchestraContext;
  agentType: Agent["agentType"];
  isAgentAdmin: boolean;
  runtimeInput: AgentRuntimeToolInput | null | undefined;
  llmApiKeyId: string | null | undefined;
  modelId: string | null | undefined;
  existing: Pick<Agent, "runtime" | "llmApiKeyId" | "modelId"> | null;
}): Promise<Partial<Pick<Agent, "runtime" | "llmApiKeyId" | "modelId">>> {
  const { context, runtimeInput, llmApiKeyId, modelId, existing } = params;
  const touchesModel = llmApiKeyId !== undefined || modelId !== undefined;
  if (runtimeInput === undefined && !touchesModel) return {};
  if (params.agentType !== "agent") {
    throw new ApiError(
      400,
      "runtime, llmApiKeyId, and modelId apply only to agents.",
    );
  }
  if (!context.userId || !context.organizationId) {
    throw new ApiError(400, "user/organization context not available.");
  }

  const runtime =
    runtimeInput == null
      ? runtimeInput
      : await resolveAgentRuntimeToolInput({
          input: runtimeInput,
          organizationId: context.organizationId,
        });
  requireAgentRuntimePermission({
    agentType: params.agentType,
    runtime,
    isAdmin: params.isAgentAdmin,
  });

  const merged = {
    runtime: runtime !== undefined ? runtime : (existing?.runtime ?? null),
    llmApiKeyId:
      llmApiKeyId !== undefined ? llmApiKeyId : (existing?.llmApiKeyId ?? null),
    modelId: modelId !== undefined ? modelId : (existing?.modelId ?? null),
  };
  const scope = {
    organizationId: context.organizationId,
    userId: context.userId,
  };
  // Stricter than the REST routes on purpose: a model is checked against the
  // caller's keys even for a chat agent, so the tool never stores a pairing
  // the caller could not have picked in the UI.
  if (touchesModel) {
    await assertAgentModelSelectionAvailable({ ...scope, agent: merged });
  }
  await assertAgentRuntimeModelCompatibility({
    ...scope,
    runtime: merged.runtime,
    agent: merged,
  });

  return {
    ...(runtime !== undefined && { runtime }),
    ...(llmApiKeyId !== undefined && { llmApiKeyId }),
    ...(modelId !== undefined && { modelId }),
  };
}

function describeRuntime(runtime: AgentRuntime | null): string {
  if (!runtime) return "built-in chat harness";
  const template = resolveAgentCatalogId(runtime);
  return template
    ? `${AGENT_CATALOG_NAMES[template]} (${runtime.image})`
    : `custom image ${runtime.image}`;
}

/**
 * Expand a runtime tool argument into the stored runtime the create and edit
 * pages would save: a template's image and launch settings, or a custom
 * image's starting values, under any fields the caller set.
 */
async function resolveAgentRuntimeToolInput(params: {
  input: AgentRuntimeToolInput;
  organizationId: string;
}): Promise<AgentRuntime> {
  const { input } = params;
  if (!("template" in input)) {
    return AgentRuntimeSchema.parse({
      ...buildCustomAgentRuntime({ image: input.image }),
      ...input,
    });
  }
  const { template, ...overrides } = input;
  const organization = await OrganizationModel.getById(params.organizationId);
  if (
    isIntegrationHidden(organization?.popularAgentOverrides ?? null, template)
  ) {
    throw new ApiError(
      400,
      `The ${AGENT_CATALOG_NAMES[template]} template is turned off for this organization.`,
    );
  }
  if (overrides.claudeCode && template !== "claude-code") {
    throw new ApiError(
      400,
      "claudeCode settings apply only to the claude-code template.",
    );
  }
  return AgentRuntimeSchema.parse({
    ...buildAgentCatalogRuntime({
      id: template,
      image: config.agentRuntime.catalogImages[template],
    }),
    ...overrides,
  });
}

async function validateKnowledgeAssignments(params: {
  userId?: string;
  organizationId?: string;
  knowledgeBaseIds?: string[];
  connectorIds?: string[];
}) {
  const { organizationId, knowledgeBaseIds, connectorIds } = params;

  if (!organizationId) {
    throw new Error(
      "organization context not available for knowledge validation",
    );
  }

  if (knowledgeBaseIds) {
    const access = params.userId
      ? await knowledgeSourceAccessControlService.buildAccessControlContext({
          userId: params.userId,
          organizationId,
        })
      : null;
    for (const kbId of knowledgeBaseIds) {
      const knowledgeBase = await KnowledgeBaseModel.findById(kbId);
      if (
        !knowledgeBase ||
        knowledgeBase.organizationId !== organizationId ||
        !(access
          ? knowledgeSourceAccessControlService.canAccessKnowledgeBase(
              access,
              knowledgeBase,
            )
          : (
              await knowledgeSourceAccessControlService.filterPublishedToOrganization(
                {
                  organizationId,
                  resource: "knowledgeBase",
                  sources: [knowledgeBase],
                  action: "read",
                },
              )
            ).length > 0)
      ) {
        throw createValidationError(
          ["knowledgeBaseIds"],
          `Knowledge base not found for this organization: ${kbId}`,
        );
      }
    }
  }

  if (connectorIds) {
    for (const connectorId of connectorIds) {
      const connector = await KnowledgeBaseConnectorModel.findById(connectorId);
      if (!connector || connector.organizationId !== organizationId) {
        throw createValidationError(
          ["connectorIds"],
          `Knowledge connector not found for this organization: ${connectorId}`,
        );
      }
    }
  }
}

function createValidationError(path: PropertyKey[], message: string) {
  return new z.ZodError([
    {
      code: "custom",
      path,
      message,
      input: undefined,
    },
  ]);
}

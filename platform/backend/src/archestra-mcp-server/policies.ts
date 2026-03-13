import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@shared";
import logger from "@/logging";
import { ToolInvocationPolicyModel, TrustedDataPolicyModel } from "@/models";
import { AutonomyPolicyOperator, ToolInvocation, TrustedData } from "@/types";
import { catchError, errorResult, successResult } from "./helpers";
import type { ArchestraContext } from "./types";

// === Constants ===

const TOOL_GET_AUTONOMY_POLICY_OPERATORS_NAME = "get_autonomy_policy_operators";
const TOOL_GET_TOOL_INVOCATION_POLICIES_NAME = "get_tool_invocation_policies";
const TOOL_CREATE_TOOL_INVOCATION_POLICY_NAME = "create_tool_invocation_policy";
const TOOL_GET_TOOL_INVOCATION_POLICY_NAME = "get_tool_invocation_policy";
const TOOL_UPDATE_TOOL_INVOCATION_POLICY_NAME = "update_tool_invocation_policy";
const TOOL_DELETE_TOOL_INVOCATION_POLICY_NAME = "delete_tool_invocation_policy";
const TOOL_GET_TRUSTED_DATA_POLICIES_NAME = "get_trusted_data_policies";
const TOOL_CREATE_TRUSTED_DATA_POLICY_NAME = "create_trusted_data_policy";
const TOOL_GET_TRUSTED_DATA_POLICY_NAME = "get_trusted_data_policy";
const TOOL_UPDATE_TRUSTED_DATA_POLICY_NAME = "update_trusted_data_policy";
const TOOL_DELETE_TRUSTED_DATA_POLICY_NAME = "delete_trusted_data_policy";

const TOOL_GET_AUTONOMY_POLICY_OPERATORS_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_GET_AUTONOMY_POLICY_OPERATORS_NAME}`;
const TOOL_GET_TOOL_INVOCATION_POLICIES_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_GET_TOOL_INVOCATION_POLICIES_NAME}`;
const TOOL_CREATE_TOOL_INVOCATION_POLICY_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_CREATE_TOOL_INVOCATION_POLICY_NAME}`;
const TOOL_GET_TOOL_INVOCATION_POLICY_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_GET_TOOL_INVOCATION_POLICY_NAME}`;
const TOOL_UPDATE_TOOL_INVOCATION_POLICY_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_UPDATE_TOOL_INVOCATION_POLICY_NAME}`;
const TOOL_DELETE_TOOL_INVOCATION_POLICY_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_DELETE_TOOL_INVOCATION_POLICY_NAME}`;
const TOOL_GET_TRUSTED_DATA_POLICIES_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_GET_TRUSTED_DATA_POLICIES_NAME}`;
const TOOL_CREATE_TRUSTED_DATA_POLICY_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_CREATE_TRUSTED_DATA_POLICY_NAME}`;
const TOOL_GET_TRUSTED_DATA_POLICY_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_GET_TRUSTED_DATA_POLICY_NAME}`;
const TOOL_UPDATE_TRUSTED_DATA_POLICY_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_UPDATE_TRUSTED_DATA_POLICY_NAME}`;
const TOOL_DELETE_TRUSTED_DATA_POLICY_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_DELETE_TRUSTED_DATA_POLICY_NAME}`;

export const toolShortNames = [
  "get_autonomy_policy_operators",
  "get_tool_invocation_policies",
  "create_tool_invocation_policy",
  "get_tool_invocation_policy",
  "update_tool_invocation_policy",
  "delete_tool_invocation_policy",
  "get_trusted_data_policies",
  "create_trusted_data_policy",
  "get_trusted_data_policy",
  "update_trusted_data_policy",
  "delete_trusted_data_policy",
] as const;

// === Exports ===

export const tools: Tool[] = [
  {
    name: TOOL_GET_AUTONOMY_POLICY_OPERATORS_FULL_NAME,
    title: "Get Autonomy Policy Operators",
    description:
      "Get all supported policy operators with their human-readable labels",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
    annotations: {},
    _meta: {},
  },
  {
    name: TOOL_GET_TOOL_INVOCATION_POLICIES_FULL_NAME,
    title: "Get Tool Invocation Policies",
    description: "Get all tool invocation policies",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
    annotations: {},
    _meta: {},
  },
  {
    name: TOOL_CREATE_TOOL_INVOCATION_POLICY_FULL_NAME,
    title: "Create Tool Invocation Policy",
    description: "Create a new tool invocation policy",
    inputSchema: {
      type: "object",
      properties: {
        toolId: {
          type: "string",
          description: "The ID of the tool (UUID from the tools table)",
        },
        conditions: {
          type: "array",
          description:
            "Array of conditions that must all match (AND logic). Empty array means unconditional.",
          items: {
            type: "object",
            properties: {
              key: {
                type: "string",
                description:
                  "The argument name or context path to evaluate (e.g., 'url', 'context.externalAgentId')",
              },
              operator: {
                type: "string",
                enum: [
                  "equal",
                  "notEqual",
                  "contains",
                  "notContains",
                  "startsWith",
                  "endsWith",
                  "regex",
                ],
              },
              value: {
                type: "string",
                description: "The value to compare against",
              },
            },
            required: ["key", "operator", "value"],
          },
        },
        action: {
          type: "string",
          enum: [
            "allow_when_context_is_untrusted",
            "block_when_context_is_untrusted",
            "block_always",
          ],
          description: "The action to take when the policy matches",
        },
        reason: {
          type: "string",
          description: "Human-readable explanation for why this policy exists",
        },
      },
      required: ["toolId", "conditions", "action"],
    },
    annotations: {},
    _meta: {},
  },
  {
    name: TOOL_GET_TOOL_INVOCATION_POLICY_FULL_NAME,
    title: "Get Tool Invocation Policy",
    description: "Get a specific tool invocation policy by ID",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The ID of the tool invocation policy",
        },
      },
      required: ["id"],
    },
    annotations: {},
    _meta: {},
  },
  {
    name: TOOL_UPDATE_TOOL_INVOCATION_POLICY_FULL_NAME,
    title: "Update Tool Invocation Policy",
    description: "Update a tool invocation policy",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The ID of the tool invocation policy to update",
        },
        toolId: {
          type: "string",
          description: "The ID of the tool (UUID from the tools table)",
        },
        conditions: {
          type: "array",
          description:
            "Array of conditions that must all match (AND logic). Empty array means unconditional.",
          items: {
            type: "object",
            properties: {
              key: {
                type: "string",
                description:
                  "The argument name or context path to evaluate (e.g., 'url', 'context.externalAgentId')",
              },
              operator: {
                type: "string",
                enum: [
                  "equal",
                  "notEqual",
                  "contains",
                  "notContains",
                  "startsWith",
                  "endsWith",
                  "regex",
                ],
              },
              value: {
                type: "string",
                description: "The value to compare against",
              },
            },
            required: ["key", "operator", "value"],
          },
        },
        action: {
          type: "string",
          enum: [
            "allow_when_context_is_untrusted",
            "block_when_context_is_untrusted",
            "block_always",
          ],
          description: "The action to take when the policy matches",
        },
        reason: {
          type: "string",
          description: "Human-readable explanation for why this policy exists",
        },
      },
      required: ["id"],
    },
    annotations: {},
    _meta: {},
  },
  {
    name: TOOL_DELETE_TOOL_INVOCATION_POLICY_FULL_NAME,
    title: "Delete Tool Invocation Policy",
    description: "Delete a tool invocation policy by ID",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The ID of the tool invocation policy",
        },
      },
      required: ["id"],
    },
    annotations: {},
    _meta: {},
  },
  {
    name: TOOL_GET_TRUSTED_DATA_POLICIES_FULL_NAME,
    title: "Get Trusted Data Policies",
    description: "Get all trusted data policies",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
    annotations: {},
    _meta: {},
  },
  {
    name: TOOL_CREATE_TRUSTED_DATA_POLICY_FULL_NAME,
    title: "Create Trusted Data Policy",
    description: "Create a new trusted data policy",
    inputSchema: {
      type: "object",
      properties: {
        toolId: {
          type: "string",
          description: "The ID of the tool (UUID from the tools table)",
        },
        conditions: {
          type: "array",
          description:
            "Array of conditions that must all match (AND logic). Empty array means unconditional.",
          items: {
            type: "object",
            properties: {
              key: {
                type: "string",
                description:
                  "The attribute key or path in the tool result to evaluate (e.g., 'emails[*].from', 'source')",
              },
              operator: {
                type: "string",
                enum: [
                  "equal",
                  "notEqual",
                  "contains",
                  "notContains",
                  "startsWith",
                  "endsWith",
                  "regex",
                ],
              },
              value: {
                type: "string",
                description: "The value to compare against",
              },
            },
            required: ["key", "operator", "value"],
          },
        },
        action: {
          type: "string",
          enum: [
            "block_always",
            "mark_as_trusted",
            "mark_as_untrusted",
            "sanitize_with_dual_llm",
          ],
          description: "The action to take when the policy matches",
        },
        description: {
          type: "string",
          description: "Human-readable explanation for why this policy exists",
        },
      },
      required: ["toolId", "conditions", "action"],
    },
    annotations: {},
    _meta: {},
  },
  {
    name: TOOL_GET_TRUSTED_DATA_POLICY_FULL_NAME,
    title: "Get Trusted Data Policy",
    description: "Get a specific trusted data policy by ID",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The ID of the trusted data policy",
        },
      },
      required: ["id"],
    },
    annotations: {},
    _meta: {},
  },
  {
    name: TOOL_UPDATE_TRUSTED_DATA_POLICY_FULL_NAME,
    title: "Update Trusted Data Policy",
    description: "Update a trusted data policy",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The ID of the trusted data policy to update",
        },
        toolId: {
          type: "string",
          description: "The ID of the tool (UUID from the tools table)",
        },
        conditions: {
          type: "array",
          description:
            "Array of conditions that must all match (AND logic). Empty array means unconditional.",
          items: {
            type: "object",
            properties: {
              key: {
                type: "string",
                description:
                  "The attribute key or path in the tool result to evaluate (e.g., 'emails[*].from', 'source')",
              },
              operator: {
                type: "string",
                enum: [
                  "equal",
                  "notEqual",
                  "contains",
                  "notContains",
                  "startsWith",
                  "endsWith",
                  "regex",
                ],
              },
              value: {
                type: "string",
                description: "The value to compare against",
              },
            },
            required: ["key", "operator", "value"],
          },
        },
        action: {
          type: "string",
          enum: [
            "block_always",
            "mark_as_trusted",
            "mark_as_untrusted",
            "sanitize_with_dual_llm",
          ],
          description: "The action to take when the policy matches",
        },
        description: {
          type: "string",
          description: "Human-readable explanation for why this policy exists",
        },
      },
      required: ["id"],
    },
    annotations: {},
    _meta: {},
  },
  {
    name: TOOL_DELETE_TRUSTED_DATA_POLICY_FULL_NAME,
    title: "Delete Trusted Data Policy",
    description: "Delete a trusted data policy by ID",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The ID of the trusted data policy",
        },
      },
      required: ["id"],
    },
    annotations: {},
    _meta: {},
  },
];

export async function handleTool(
  toolName: string,
  args: Record<string, unknown> | undefined,
  context: ArchestraContext,
): Promise<CallToolResult | null> {
  const { agent: contextAgent } = context;

  if (toolName === TOOL_GET_AUTONOMY_POLICY_OPERATORS_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id },
      "get_autonomy_policy_operators tool called",
    );

    try {
      const supportedOperators = Object.values(
        AutonomyPolicyOperator.SupportedOperatorSchema.enum,
      ).map((value) => {
        // Convert camel case to title case
        const titleCaseConversion = value.replace(/([A-Z])/g, " $1");
        const label =
          titleCaseConversion.charAt(0).toUpperCase() +
          titleCaseConversion.slice(1);

        return { value, label };
      });

      return successResult(JSON.stringify(supportedOperators, null, 2));
    } catch (error) {
      return catchError(error, "getting autonomy policy operators");
    }
  }

  if (toolName === TOOL_GET_TOOL_INVOCATION_POLICIES_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id },
      "get_tool_invocation_policies tool called",
    );

    try {
      const policies = await ToolInvocationPolicyModel.findAll();
      return successResult(JSON.stringify(policies, null, 2));
    } catch (error) {
      return catchError(error, "getting tool invocation policies");
    }
  }

  if (toolName === TOOL_CREATE_TOOL_INVOCATION_POLICY_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id, createArgs: args },
      "create_tool_invocation_policy tool called",
    );

    try {
      const a = args ?? {};
      const validated = ToolInvocation.InsertToolInvocationPolicySchema.parse({
        toolId: a.toolId,
        conditions: a.conditions ?? [],
        action: a.action,
        reason: a.reason ?? null,
      });
      const policy = await ToolInvocationPolicyModel.create(validated);
      return successResult(JSON.stringify(policy, null, 2));
    } catch (error) {
      return catchError(error, "creating tool invocation policy");
    }
  }

  if (toolName === TOOL_GET_TOOL_INVOCATION_POLICY_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id, policyId: args?.id },
      "get_tool_invocation_policy tool called",
    );

    try {
      const id = args?.id as string;
      if (!id) {
        return errorResult("id parameter is required");
      }

      const policy = await ToolInvocationPolicyModel.findById(id);
      if (!policy) {
        return errorResult("Tool invocation policy not found");
      }

      return successResult(JSON.stringify(policy, null, 2));
    } catch (error) {
      return catchError(error, "getting tool invocation policy");
    }
  }

  if (toolName === TOOL_UPDATE_TOOL_INVOCATION_POLICY_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id, updateArgs: args },
      "update_tool_invocation_policy tool called",
    );

    try {
      const a = args ?? {};
      const id = a.id as string;
      if (!id) {
        return errorResult("id parameter is required");
      }

      const rawUpdate: Record<string, unknown> = {};
      if (a.toolId !== undefined) rawUpdate.toolId = a.toolId;
      if (a.conditions !== undefined) rawUpdate.conditions = a.conditions;
      if (a.action !== undefined) rawUpdate.action = a.action;
      if (a.reason !== undefined) rawUpdate.reason = a.reason ?? null;

      const updateData =
        ToolInvocation.InsertToolInvocationPolicySchema.partial().parse(
          rawUpdate,
        );

      const policy = await ToolInvocationPolicyModel.update(id, updateData);
      if (!policy) {
        return errorResult("Tool invocation policy not found");
      }

      return successResult(JSON.stringify(policy, null, 2));
    } catch (error) {
      return catchError(error, "updating tool invocation policy");
    }
  }

  if (toolName === TOOL_DELETE_TOOL_INVOCATION_POLICY_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id, policyId: args?.id },
      "delete_tool_invocation_policy tool called",
    );

    try {
      const id = args?.id as string;
      if (!id) {
        return errorResult("id parameter is required");
      }

      const success = await ToolInvocationPolicyModel.delete(id);
      if (!success) {
        return errorResult("Tool invocation policy not found");
      }

      return successResult(JSON.stringify({ success: true }, null, 2));
    } catch (error) {
      return catchError(error, "deleting tool invocation policy");
    }
  }

  if (toolName === TOOL_GET_TRUSTED_DATA_POLICIES_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id },
      "get_trusted_data_policies tool called",
    );

    try {
      const policies = await TrustedDataPolicyModel.findAll();
      return successResult(JSON.stringify(policies, null, 2));
    } catch (error) {
      return catchError(error, "getting trusted data policies");
    }
  }

  if (toolName === TOOL_CREATE_TRUSTED_DATA_POLICY_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id, createArgs: args },
      "create_trusted_data_policy tool called",
    );

    try {
      const a = args ?? {};
      const validated = TrustedData.InsertTrustedDataPolicySchema.parse({
        toolId: a.toolId,
        conditions: a.conditions ?? [],
        action: a.action,
        description: a.description ?? null,
      });
      const policy = await TrustedDataPolicyModel.create(validated);
      return successResult(JSON.stringify(policy, null, 2));
    } catch (error) {
      return catchError(error, "creating trusted data policy");
    }
  }

  if (toolName === TOOL_GET_TRUSTED_DATA_POLICY_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id, policyId: args?.id },
      "get_trusted_data_policy tool called",
    );

    try {
      const id = args?.id as string;
      if (!id) {
        return errorResult("id parameter is required");
      }

      const policy = await TrustedDataPolicyModel.findById(id);
      if (!policy) {
        return errorResult("Trusted data policy not found");
      }

      return successResult(JSON.stringify(policy, null, 2));
    } catch (error) {
      return catchError(error, "getting trusted data policy");
    }
  }

  if (toolName === TOOL_UPDATE_TRUSTED_DATA_POLICY_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id, updateArgs: args },
      "update_trusted_data_policy tool called",
    );

    try {
      const a = args ?? {};
      const id = a.id as string;
      if (!id) {
        return errorResult("id parameter is required");
      }

      const rawUpdate: Record<string, unknown> = {};
      if (a.toolId !== undefined) rawUpdate.toolId = a.toolId;
      if (a.conditions !== undefined) rawUpdate.conditions = a.conditions;
      if (a.action !== undefined) rawUpdate.action = a.action;
      if (a.description !== undefined)
        rawUpdate.description = a.description ?? null;

      const updateData =
        TrustedData.InsertTrustedDataPolicySchema.partial().parse(rawUpdate);

      const policy = await TrustedDataPolicyModel.update(id, updateData);
      if (!policy) {
        return errorResult("Trusted data policy not found");
      }

      return successResult(JSON.stringify(policy, null, 2));
    } catch (error) {
      return catchError(error, "updating trusted data policy");
    }
  }

  if (toolName === TOOL_DELETE_TRUSTED_DATA_POLICY_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id, policyId: args?.id },
      "delete_trusted_data_policy tool called",
    );

    try {
      const id = args?.id as string;
      if (!id) {
        return errorResult("id parameter is required");
      }

      const success = await TrustedDataPolicyModel.delete(id);
      if (!success) {
        return errorResult("Trusted data policy not found");
      }

      return successResult(JSON.stringify({ success: true }, null, 2));
    } catch (error) {
      return catchError(error, "deleting trusted data policy");
    }
  }

  return null;
}

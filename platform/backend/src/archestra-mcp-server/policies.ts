import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import logger from "@/logging";
import { ToolInvocationPolicyModel, TrustedDataPolicyModel } from "@/models";
import {
  AutonomyPolicyOperator,
  ToolInvocation,
  TrustedData,
  UuidIdSchema,
} from "@/types";
import {
  catchError,
  defineArchestraTools,
  EmptyToolArgsSchema,
  errorResult,
  successResult,
} from "./helpers";
import type { ArchestraContext } from "./types";

// === Constants ===

const ToolInvocationConditionSchema = z
  .object({
    key: z
      .string()
      .describe(
        "The argument name or context path to evaluate (for example `url` or `context.externalAgentId`).",
      ),
    operator: AutonomyPolicyOperator.SupportedOperatorSchema.describe(
      "The comparison operator.",
    ),
    value: z.string().describe("The value to compare against."),
  })
  .strict();

const TrustedDataConditionSchema = z
  .object({
    key: z
      .string()
      .describe(
        "The attribute key or path in the tool result to evaluate (for example `emails[*].from` or `source`).",
      ),
    operator: AutonomyPolicyOperator.SupportedOperatorSchema.describe(
      "The comparison operator.",
    ),
    value: z.string().describe("The value to compare against."),
  })
  .strict();

const createToolInvocationPolicySchema = z
  .object({
    toolId: UuidIdSchema.describe(
      "The ID of the tool (UUID from the tools table).",
    ),
    conditions: z
      .array(ToolInvocationConditionSchema)
      .describe(
        "Array of conditions that must all match. Empty array means unconditional.",
      ),
    action:
      ToolInvocation.InsertToolInvocationPolicySchema.shape.action.describe(
        "The action to take when the policy matches.",
      ),
    reason: z
      .string()
      .optional()
      .describe("Human-readable explanation for why this policy exists."),
  })
  .strict();

const updateToolInvocationPolicySchema = z
  .object({
    id: UuidIdSchema.describe(
      "The ID of the tool invocation policy to update.",
    ),
    toolId: UuidIdSchema.optional().describe(
      "The ID of the tool (UUID from the tools table).",
    ),
    conditions: z
      .array(ToolInvocationConditionSchema)
      .optional()
      .describe(
        "Updated array of conditions that must all match. Empty array means unconditional.",
      ),
    action: ToolInvocation.InsertToolInvocationPolicySchema.shape.action
      .optional()
      .describe("Updated action to take when the policy matches."),
    reason: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Updated human-readable explanation for why this policy exists.",
      ),
  })
  .strict();

const createTrustedDataPolicySchema = z
  .object({
    toolId: UuidIdSchema.describe(
      "The ID of the tool (UUID from the tools table).",
    ),
    conditions: z
      .array(TrustedDataConditionSchema)
      .describe(
        "Array of conditions that must all match. Empty array means unconditional.",
      ),
    action: TrustedData.InsertTrustedDataPolicySchema.shape.action.describe(
      "The action to take when the policy matches.",
    ),
    description: z
      .string()
      .optional()
      .describe("Human-readable explanation for why this policy exists."),
  })
  .strict();

const updateTrustedDataPolicySchema = z
  .object({
    id: UuidIdSchema.describe("The ID of the trusted data policy to update."),
    toolId: UuidIdSchema.optional().describe(
      "The ID of the tool (UUID from the tools table).",
    ),
    conditions: z
      .array(TrustedDataConditionSchema)
      .optional()
      .describe(
        "Updated array of conditions that must all match. Empty array means unconditional.",
      ),
    action: TrustedData.InsertTrustedDataPolicySchema.shape.action
      .optional()
      .describe("Updated action to take when the policy matches."),
    description: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Updated human-readable explanation for why this policy exists.",
      ),
  })
  .strict();

const registry = defineArchestraTools([
  {
    shortName: "get_autonomy_policy_operators",
    title: "Get Autonomy Policy Operators",
    description:
      "Get all supported policy operators with their human-readable labels",
    schema: EmptyToolArgsSchema,
  },
  {
    shortName: "get_tool_invocation_policies",
    title: "Get Tool Invocation Policies",
    description: "Get all tool invocation policies",
    schema: EmptyToolArgsSchema,
  },
  {
    shortName: "create_tool_invocation_policy",
    title: "Create Tool Invocation Policy",
    description: "Create a new tool invocation policy",
    schema: createToolInvocationPolicySchema,
  },
  {
    shortName: "get_tool_invocation_policy",
    title: "Get Tool Invocation Policy",
    description: "Get a specific tool invocation policy by ID",
    schema: z
      .object({
        id: UuidIdSchema.describe("The ID of the tool invocation policy."),
      })
      .strict(),
  },
  {
    shortName: "update_tool_invocation_policy",
    title: "Update Tool Invocation Policy",
    description: "Update a tool invocation policy",
    schema: updateToolInvocationPolicySchema,
  },
  {
    shortName: "delete_tool_invocation_policy",
    title: "Delete Tool Invocation Policy",
    description: "Delete a tool invocation policy by ID",
    schema: z
      .object({
        id: UuidIdSchema.describe("The ID of the tool invocation policy."),
      })
      .strict(),
  },
  {
    shortName: "get_trusted_data_policies",
    title: "Get Trusted Data Policies",
    description: "Get all trusted data policies",
    schema: EmptyToolArgsSchema,
  },
  {
    shortName: "create_trusted_data_policy",
    title: "Create Trusted Data Policy",
    description: "Create a new trusted data policy",
    schema: createTrustedDataPolicySchema,
  },
  {
    shortName: "get_trusted_data_policy",
    title: "Get Trusted Data Policy",
    description: "Get a specific trusted data policy by ID",
    schema: z
      .object({
        id: UuidIdSchema.describe("The ID of the trusted data policy."),
      })
      .strict(),
  },
  {
    shortName: "update_trusted_data_policy",
    title: "Update Trusted Data Policy",
    description: "Update a trusted data policy",
    schema: updateTrustedDataPolicySchema,
  },
  {
    shortName: "delete_trusted_data_policy",
    title: "Delete Trusted Data Policy",
    description: "Delete a trusted data policy by ID",
    schema: z
      .object({
        id: UuidIdSchema.describe("The ID of the trusted data policy."),
      })
      .strict(),
  },
] as const);

const {
  get_autonomy_policy_operators: TOOL_GET_AUTONOMY_POLICY_OPERATORS_FULL_NAME,
  get_tool_invocation_policies: TOOL_GET_TOOL_INVOCATION_POLICIES_FULL_NAME,
  create_tool_invocation_policy: TOOL_CREATE_TOOL_INVOCATION_POLICY_FULL_NAME,
  get_tool_invocation_policy: TOOL_GET_TOOL_INVOCATION_POLICY_FULL_NAME,
  update_tool_invocation_policy: TOOL_UPDATE_TOOL_INVOCATION_POLICY_FULL_NAME,
  delete_tool_invocation_policy: TOOL_DELETE_TOOL_INVOCATION_POLICY_FULL_NAME,
  get_trusted_data_policies: TOOL_GET_TRUSTED_DATA_POLICIES_FULL_NAME,
  create_trusted_data_policy: TOOL_CREATE_TRUSTED_DATA_POLICY_FULL_NAME,
  get_trusted_data_policy: TOOL_GET_TRUSTED_DATA_POLICY_FULL_NAME,
  update_trusted_data_policy: TOOL_UPDATE_TRUSTED_DATA_POLICY_FULL_NAME,
  delete_trusted_data_policy: TOOL_DELETE_TRUSTED_DATA_POLICY_FULL_NAME,
} = registry.toolFullNames;

export const toolShortNames = registry.toolShortNames;
export const toolArgsSchemas = registry.toolArgsSchemas;

// === Exports ===

export const tools = registry.tools;

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

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
  defineArchestraTool,
  defineArchestraTools,
  EmptyToolArgsSchema,
  errorResult,
  getArchestraToolFullName,
  structuredSuccessResult,
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

const AutonomyPolicyOperatorOutputSchema = z.object({
  value: AutonomyPolicyOperator.SupportedOperatorSchema.describe(
    "The operator enum value.",
  ),
  label: z.string().describe("The human-readable label."),
});

const OperatorsOutputSchema = z.object({
  operators: z
    .array(AutonomyPolicyOperatorOutputSchema)
    .describe("Supported autonomy policy operators."),
});

const ToolInvocationPolicyConditionOutputSchema = z.object({
  key: z.string().describe("The evaluated argument or context key."),
  operator: AutonomyPolicyOperator.SupportedOperatorSchema.describe(
    "The comparison operator.",
  ),
  value: z.string().describe("The comparison value."),
});

const ToolInvocationPolicyOutputItemSchema = z.object({
  id: z.string().describe("The policy ID."),
  toolId: z.string().describe("The tool ID this policy targets."),
  conditions: z
    .array(ToolInvocationPolicyConditionOutputSchema)
    .describe("Conditions evaluated for the policy."),
  action:
    ToolInvocation.InsertToolInvocationPolicySchema.shape.action.describe(
      "The policy action.",
    ),
  reason: z.string().nullable().describe("The policy reason, if any."),
});

const ToolInvocationPoliciesOutputSchema = z.object({
  policies: z
    .array(ToolInvocationPolicyOutputItemSchema)
    .describe("Tool invocation policies."),
});

const ToolInvocationPolicyOutputSchema = z.object({
  policy: ToolInvocationPolicyOutputItemSchema.describe(
    "The requested tool invocation policy.",
  ),
});

const TrustedDataPolicyConditionOutputSchema = z.object({
  key: z.string().describe("The evaluated result key or path."),
  operator: AutonomyPolicyOperator.SupportedOperatorSchema.describe(
    "The comparison operator.",
  ),
  value: z.string().describe("The comparison value."),
});

const TrustedDataPolicyOutputItemSchema = z.object({
  id: z.string().describe("The policy ID."),
  toolId: z.string().describe("The tool ID this policy targets."),
  conditions: z
    .array(TrustedDataPolicyConditionOutputSchema)
    .describe("Conditions evaluated for the policy."),
  action:
    TrustedData.InsertTrustedDataPolicySchema.shape.action.describe(
      "The policy action.",
    ),
  description: z
    .string()
    .nullable()
    .describe("The policy description, if any."),
});

const TrustedDataPoliciesOutputSchema = z.object({
  policies: z
    .array(TrustedDataPolicyOutputItemSchema)
    .describe("Trusted data policies."),
});

const TrustedDataPolicyOutputSchema = z.object({
  policy: TrustedDataPolicyOutputItemSchema.describe(
    "The requested trusted data policy.",
  ),
});

const DeletePolicyOutputSchema = z.object({
  success: z.literal(true).describe("Whether the delete succeeded."),
});

const GetToolInvocationPolicyToolArgsSchema = z
  .object({
    id: UuidIdSchema.describe("The ID of the tool invocation policy."),
  })
  .strict();

const DeleteToolInvocationPolicyToolArgsSchema = z
  .object({
    id: UuidIdSchema.describe("The ID of the tool invocation policy."),
  })
  .strict();

const GetTrustedDataPolicyToolArgsSchema = z
  .object({
    id: UuidIdSchema.describe("The ID of the trusted data policy."),
  })
  .strict();

const DeleteTrustedDataPolicyToolArgsSchema = z
  .object({
    id: UuidIdSchema.describe("The ID of the trusted data policy."),
  })
  .strict();

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: "get_autonomy_policy_operators",
    title: "Get Autonomy Policy Operators",
    description:
      "Get all supported policy operators with their human-readable labels",
    schema: EmptyToolArgsSchema,
    outputSchema: OperatorsOutputSchema,
    async handler({ args, context }) {
      return callKnownTool(
        getArchestraToolFullName("get_autonomy_policy_operators"),
        args,
        context,
      );
    },
  }),
  defineArchestraTool({
    shortName: "get_tool_invocation_policies",
    title: "Get Tool Invocation Policies",
    description: "Get all tool invocation policies",
    schema: EmptyToolArgsSchema,
    outputSchema: ToolInvocationPoliciesOutputSchema,
    async handler({ args, context }) {
      return callKnownTool(
        getArchestraToolFullName("get_tool_invocation_policies"),
        args,
        context,
      );
    },
  }),
  defineArchestraTool({
    shortName: "create_tool_invocation_policy",
    title: "Create Tool Invocation Policy",
    description: "Create a new tool invocation policy",
    schema: createToolInvocationPolicySchema,
    outputSchema: ToolInvocationPolicyOutputSchema,
    async handler({ args, context }) {
      return callKnownTool(
        getArchestraToolFullName("create_tool_invocation_policy"),
        args,
        context,
      );
    },
  }),
  defineArchestraTool({
    shortName: "get_tool_invocation_policy",
    title: "Get Tool Invocation Policy",
    description: "Get a specific tool invocation policy by ID",
    schema: GetToolInvocationPolicyToolArgsSchema,
    outputSchema: ToolInvocationPolicyOutputSchema,
    async handler({ args, context }) {
      return callKnownTool(
        getArchestraToolFullName("get_tool_invocation_policy"),
        args,
        context,
      );
    },
  }),
  defineArchestraTool({
    shortName: "update_tool_invocation_policy",
    title: "Update Tool Invocation Policy",
    description: "Update a tool invocation policy",
    schema: updateToolInvocationPolicySchema,
    outputSchema: ToolInvocationPolicyOutputSchema,
    async handler({ args, context }) {
      return callKnownTool(
        getArchestraToolFullName("update_tool_invocation_policy"),
        args,
        context,
      );
    },
  }),
  defineArchestraTool({
    shortName: "delete_tool_invocation_policy",
    title: "Delete Tool Invocation Policy",
    description: "Delete a tool invocation policy by ID",
    schema: DeleteToolInvocationPolicyToolArgsSchema,
    outputSchema: DeletePolicyOutputSchema,
    async handler({ args, context }) {
      return callKnownTool(
        getArchestraToolFullName("delete_tool_invocation_policy"),
        args,
        context,
      );
    },
  }),
  defineArchestraTool({
    shortName: "get_trusted_data_policies",
    title: "Get Trusted Data Policies",
    description: "Get all trusted data policies",
    schema: EmptyToolArgsSchema,
    outputSchema: TrustedDataPoliciesOutputSchema,
    async handler({ args, context }) {
      return callKnownTool(
        getArchestraToolFullName("get_trusted_data_policies"),
        args,
        context,
      );
    },
  }),
  defineArchestraTool({
    shortName: "create_trusted_data_policy",
    title: "Create Trusted Data Policy",
    description: "Create a new trusted data policy",
    schema: createTrustedDataPolicySchema,
    outputSchema: TrustedDataPolicyOutputSchema,
    async handler({ args, context }) {
      return callKnownTool(
        getArchestraToolFullName("create_trusted_data_policy"),
        args,
        context,
      );
    },
  }),
  defineArchestraTool({
    shortName: "get_trusted_data_policy",
    title: "Get Trusted Data Policy",
    description: "Get a specific trusted data policy by ID",
    schema: GetTrustedDataPolicyToolArgsSchema,
    outputSchema: TrustedDataPolicyOutputSchema,
    async handler({ args, context }) {
      return callKnownTool(
        getArchestraToolFullName("get_trusted_data_policy"),
        args,
        context,
      );
    },
  }),
  defineArchestraTool({
    shortName: "update_trusted_data_policy",
    title: "Update Trusted Data Policy",
    description: "Update a trusted data policy",
    schema: updateTrustedDataPolicySchema,
    outputSchema: TrustedDataPolicyOutputSchema,
    async handler({ args, context }) {
      return callKnownTool(
        getArchestraToolFullName("update_trusted_data_policy"),
        args,
        context,
      );
    },
  }),
  defineArchestraTool({
    shortName: "delete_trusted_data_policy",
    title: "Delete Trusted Data Policy",
    description: "Delete a trusted data policy by ID",
    schema: DeleteTrustedDataPolicyToolArgsSchema,
    outputSchema: DeletePolicyOutputSchema,
    async handler({ args, context }) {
      return callKnownTool(
        getArchestraToolFullName("delete_trusted_data_policy"),
        args,
        context,
      );
    },
  }),
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
export const toolOutputSchemas = registry.toolOutputSchemas;
export const toolEntries = registry.toolEntries;

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

      return structuredSuccessResult(
        { operators: supportedOperators },
        JSON.stringify(supportedOperators, null, 2),
      );
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
      return structuredSuccessResult(
        { policies },
        JSON.stringify(policies, null, 2),
      );
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
      return structuredSuccessResult(
        { policy },
        JSON.stringify(policy, null, 2),
      );
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

      return structuredSuccessResult(
        { policy },
        JSON.stringify(policy, null, 2),
      );
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

      return structuredSuccessResult(
        { policy },
        JSON.stringify(policy, null, 2),
      );
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

      return structuredSuccessResult(
        { success: true },
        JSON.stringify({ success: true }, null, 2),
      );
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
      return structuredSuccessResult(
        { policies },
        JSON.stringify(policies, null, 2),
      );
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
      return structuredSuccessResult(
        { policy },
        JSON.stringify(policy, null, 2),
      );
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

      return structuredSuccessResult(
        { policy },
        JSON.stringify(policy, null, 2),
      );
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

      return structuredSuccessResult(
        { policy },
        JSON.stringify(policy, null, 2),
      );
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

      return structuredSuccessResult(
        { success: true },
        JSON.stringify({ success: true }, null, 2),
      );
    } catch (error) {
      return catchError(error, "deleting trusted data policy");
    }
  }

  return null;
}

async function callKnownTool(
  toolName: string,
  args: object | undefined,
  context: ArchestraContext,
): Promise<CallToolResult> {
  const result = await handleTool(
    toolName,
    args as Record<string, unknown> | undefined,
    context,
  );
  if (!result) {
    throw new Error(`Tool not handled: ${toolName}`);
  }
  return result;
}

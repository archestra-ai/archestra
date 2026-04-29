import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  TOOL_CREATE_TOOL_INVOCATION_POLICY_SHORT_NAME,
  TOOL_CREATE_TRUSTED_DATA_POLICY_SHORT_NAME,
  TOOL_DELETE_TOOL_INVOCATION_POLICY_SHORT_NAME,
  TOOL_DELETE_TRUSTED_DATA_POLICY_SHORT_NAME,
  TOOL_GET_AUTONOMY_POLICY_OPERATORS_SHORT_NAME,
  TOOL_GET_TOOL_INVOCATION_POLICIES_SHORT_NAME,
  TOOL_GET_TOOL_INVOCATION_POLICY_SHORT_NAME,
  TOOL_GET_TRUSTED_DATA_POLICIES_SHORT_NAME,
  TOOL_GET_TRUSTED_DATA_POLICY_SHORT_NAME,
  TOOL_UPDATE_TOOL_INVOCATION_POLICY_SHORT_NAME,
  TOOL_UPDATE_TRUSTED_DATA_POLICY_SHORT_NAME,
} from "@shared";
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
  structuredSuccessResult,
} from "./helpers";
import type { ArchestraContext } from "./types";

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

type CreateToolInvocationPolicyArgs = z.infer<
  typeof createToolInvocationPolicySchema
>;
type UpdateToolInvocationPolicyArgs = z.infer<
  typeof updateToolInvocationPolicySchema
>;
type CreateTrustedDataPolicyArgs = z.infer<
  typeof createTrustedDataPolicySchema
>;
type UpdateTrustedDataPolicyArgs = z.infer<
  typeof updateTrustedDataPolicySchema
>;
type GetToolInvocationPolicyArgs = z.infer<
  typeof GetToolInvocationPolicyToolArgsSchema
>;
type DeleteToolInvocationPolicyArgs = z.infer<
  typeof DeleteToolInvocationPolicyToolArgsSchema
>;
type GetTrustedDataPolicyArgs = z.infer<
  typeof GetTrustedDataPolicyToolArgsSchema
>;
type DeleteTrustedDataPolicyArgs = z.infer<
  typeof DeleteTrustedDataPolicyToolArgsSchema
>;

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: TOOL_GET_AUTONOMY_POLICY_OPERATORS_SHORT_NAME,
    title: "Get Autonomy Policy Operators",
    description:
      "Get all supported policy operators with their human-readable labels",
    schema: EmptyToolArgsSchema,
    outputSchema: OperatorsOutputSchema,
    handler: ({ context }) => handleGetAutonomyPolicyOperators(context),
  }),
  defineArchestraTool({
    shortName: TOOL_GET_TOOL_INVOCATION_POLICIES_SHORT_NAME,
    title: "Get Tool Invocation Policies",
    description: "Get all tool invocation policies",
    schema: EmptyToolArgsSchema,
    outputSchema: ToolInvocationPoliciesOutputSchema,
    handler: ({ context }) => handleGetToolInvocationPolicies(context),
  }),
  defineArchestraTool({
    shortName: TOOL_CREATE_TOOL_INVOCATION_POLICY_SHORT_NAME,
    title: "Create Tool Invocation Policy",
    description: "Create a new tool invocation policy",
    schema: createToolInvocationPolicySchema,
    outputSchema: ToolInvocationPolicyOutputSchema,
    handler: ({ args, context }) =>
      handleCreateToolInvocationPolicy(args, context),
  }),
  defineArchestraTool({
    shortName: TOOL_GET_TOOL_INVOCATION_POLICY_SHORT_NAME,
    title: "Get Tool Invocation Policy",
    description: "Get a specific tool invocation policy by ID",
    schema: GetToolInvocationPolicyToolArgsSchema,
    outputSchema: ToolInvocationPolicyOutputSchema,
    handler: ({ args, context }) =>
      handleGetToolInvocationPolicy(args, context),
  }),
  defineArchestraTool({
    shortName: TOOL_UPDATE_TOOL_INVOCATION_POLICY_SHORT_NAME,
    title: "Update Tool Invocation Policy",
    description: "Update a tool invocation policy",
    schema: updateToolInvocationPolicySchema,
    outputSchema: ToolInvocationPolicyOutputSchema,
    handler: ({ args, context }) =>
      handleUpdateToolInvocationPolicy(args, context),
  }),
  defineArchestraTool({
    shortName: TOOL_DELETE_TOOL_INVOCATION_POLICY_SHORT_NAME,
    title: "Delete Tool Invocation Policy",
    description: "Delete a tool invocation policy by ID",
    schema: DeleteToolInvocationPolicyToolArgsSchema,
    outputSchema: DeletePolicyOutputSchema,
    handler: ({ args, context }) =>
      handleDeleteToolInvocationPolicy(args, context),
  }),
  defineArchestraTool({
    shortName: TOOL_GET_TRUSTED_DATA_POLICIES_SHORT_NAME,
    title: "Get Trusted Data Policies",
    description: "Get all trusted data policies",
    schema: EmptyToolArgsSchema,
    outputSchema: TrustedDataPoliciesOutputSchema,
    handler: ({ context }) => handleGetTrustedDataPolicies(context),
  }),
  defineArchestraTool({
    shortName: TOOL_CREATE_TRUSTED_DATA_POLICY_SHORT_NAME,
    title: "Create Trusted Data Policy",
    description: "Create a new trusted data policy",
    schema: createTrustedDataPolicySchema,
    outputSchema: TrustedDataPolicyOutputSchema,
    handler: ({ args, context }) =>
      handleCreateTrustedDataPolicy(args, context),
  }),
  defineArchestraTool({
    shortName: TOOL_GET_TRUSTED_DATA_POLICY_SHORT_NAME,
    title: "Get Trusted Data Policy",
    description: "Get a specific trusted data policy by ID",
    schema: GetTrustedDataPolicyToolArgsSchema,
    outputSchema: TrustedDataPolicyOutputSchema,
    handler: ({ args, context }) => handleGetTrustedDataPolicy(args, context),
  }),
  defineArchestraTool({
    shortName: TOOL_UPDATE_TRUSTED_DATA_POLICY_SHORT_NAME,
    title: "Update Trusted Data Policy",
    description: "Update a trusted data policy",
    schema: updateTrustedDataPolicySchema,
    outputSchema: TrustedDataPolicyOutputSchema,
    handler: ({ args, context }) =>
      handleUpdateTrustedDataPolicy(args, context),
  }),
  defineArchestraTool({
    shortName: TOOL_DELETE_TRUSTED_DATA_POLICY_SHORT_NAME,
    title: "Delete Trusted Data Policy",
    description: "Delete a trusted data policy by ID",
    schema: DeleteTrustedDataPolicyToolArgsSchema,
    outputSchema: DeletePolicyOutputSchema,
    handler: ({ args, context }) =>
      handleDeleteTrustedDataPolicy(args, context),
  }),
] as const);

export const toolEntries = registry.toolEntries;

// === Exports ===

export const tools = registry.tools;

async function handleGetAutonomyPolicyOperators(
  context: ArchestraContext,
): Promise<CallToolResult> {
  const { agent: contextAgent } = context;
  logger.info(
    { agentId: contextAgent.id },
    "get_autonomy_policy_operators tool called",
  );

  try {
    const supportedOperators = Object.values(
      AutonomyPolicyOperator.SupportedOperatorSchema.enum,
    ).map((value) => {
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

async function handleGetToolInvocationPolicies(
  context: ArchestraContext,
): Promise<CallToolResult> {
  const { agent: contextAgent } = context;

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

async function handleCreateToolInvocationPolicy(
  args: CreateToolInvocationPolicyArgs,
  context: ArchestraContext,
): Promise<CallToolResult> {
  const { agent: contextAgent } = context;

  logger.info(
    { agentId: contextAgent.id, createArgs: args },
    "create_tool_invocation_policy tool called",
  );

  try {
    const validated = ToolInvocation.InsertToolInvocationPolicySchema.parse({
      toolId: args.toolId,
      conditions: args.conditions ?? [],
      action: args.action,
      reason: args.reason ?? null,
    });
    const policy = await ToolInvocationPolicyModel.create(validated);
    return structuredSuccessResult({ policy }, JSON.stringify(policy, null, 2));
  } catch (error) {
    return catchError(error, "creating tool invocation policy");
  }
}

async function handleGetToolInvocationPolicy(
  args: GetToolInvocationPolicyArgs,
  context: ArchestraContext,
): Promise<CallToolResult> {
  const { agent: contextAgent } = context;

  logger.info(
    { agentId: contextAgent.id, policyId: args.id },
    "get_tool_invocation_policy tool called",
  );

  try {
    const policy = await ToolInvocationPolicyModel.findById(args.id);
    if (!policy) {
      return errorResult("Tool invocation policy not found");
    }

    return structuredSuccessResult({ policy }, JSON.stringify(policy, null, 2));
  } catch (error) {
    return catchError(error, "getting tool invocation policy");
  }
}

async function handleUpdateToolInvocationPolicy(
  args: UpdateToolInvocationPolicyArgs,
  context: ArchestraContext,
): Promise<CallToolResult> {
  const { agent: contextAgent } = context;

  logger.info(
    { agentId: contextAgent.id, updateArgs: args },
    "update_tool_invocation_policy tool called",
  );

  try {
    const rawUpdate: Record<string, unknown> = {};
    if (args.toolId !== undefined) rawUpdate.toolId = args.toolId;
    if (args.conditions !== undefined) rawUpdate.conditions = args.conditions;
    if (args.action !== undefined) rawUpdate.action = args.action;
    if (args.reason !== undefined) rawUpdate.reason = args.reason ?? null;

    const updateData =
      ToolInvocation.InsertToolInvocationPolicySchema.partial().parse(
        rawUpdate,
      );

    const policy = await ToolInvocationPolicyModel.update(args.id, updateData);
    if (!policy) {
      return errorResult("Tool invocation policy not found");
    }

    return structuredSuccessResult({ policy }, JSON.stringify(policy, null, 2));
  } catch (error) {
    return catchError(error, "updating tool invocation policy");
  }
}

async function handleDeleteToolInvocationPolicy(
  args: DeleteToolInvocationPolicyArgs,
  context: ArchestraContext,
): Promise<CallToolResult> {
  const { agent: contextAgent } = context;

  logger.info(
    { agentId: contextAgent.id, policyId: args.id },
    "delete_tool_invocation_policy tool called",
  );

  try {
    const success = await ToolInvocationPolicyModel.delete(args.id);
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

async function handleGetTrustedDataPolicies(
  context: ArchestraContext,
): Promise<CallToolResult> {
  const { agent: contextAgent } = context;

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

async function handleCreateTrustedDataPolicy(
  args: CreateTrustedDataPolicyArgs,
  context: ArchestraContext,
): Promise<CallToolResult> {
  const { agent: contextAgent } = context;

  logger.info(
    { agentId: contextAgent.id, createArgs: args },
    "create_trusted_data_policy tool called",
  );

  try {
    const validated = TrustedData.InsertTrustedDataPolicySchema.parse({
      toolId: args.toolId,
      conditions: args.conditions ?? [],
      action: args.action,
      description: args.description ?? null,
    });
    const policy = await TrustedDataPolicyModel.create(validated);
    return structuredSuccessResult({ policy }, JSON.stringify(policy, null, 2));
  } catch (error) {
    return catchError(error, "creating trusted data policy");
  }
}

async function handleGetTrustedDataPolicy(
  args: GetTrustedDataPolicyArgs,
  context: ArchestraContext,
): Promise<CallToolResult> {
  const { agent: contextAgent } = context;

  logger.info(
    { agentId: contextAgent.id, policyId: args.id },
    "get_trusted_data_policy tool called",
  );

  try {
    const policy = await TrustedDataPolicyModel.findById(args.id);
    if (!policy) {
      return errorResult("Trusted data policy not found");
    }

    return structuredSuccessResult({ policy }, JSON.stringify(policy, null, 2));
  } catch (error) {
    return catchError(error, "getting trusted data policy");
  }
}

async function handleUpdateTrustedDataPolicy(
  args: UpdateTrustedDataPolicyArgs,
  context: ArchestraContext,
): Promise<CallToolResult> {
  const { agent: contextAgent } = context;

  logger.info(
    { agentId: contextAgent.id, updateArgs: args },
    "update_trusted_data_policy tool called",
  );

  try {
    const rawUpdate: Record<string, unknown> = {};
    if (args.toolId !== undefined) rawUpdate.toolId = args.toolId;
    if (args.conditions !== undefined) rawUpdate.conditions = args.conditions;
    if (args.action !== undefined) rawUpdate.action = args.action;
    if (args.description !== undefined)
      rawUpdate.description = args.description ?? null;

    const updateData =
      TrustedData.InsertTrustedDataPolicySchema.partial().parse(rawUpdate);

    const policy = await TrustedDataPolicyModel.update(args.id, updateData);
    if (!policy) {
      return errorResult("Trusted data policy not found");
    }

    return structuredSuccessResult({ policy }, JSON.stringify(policy, null, 2));
  } catch (error) {
    return catchError(error, "updating trusted data policy");
  }
}

async function handleDeleteTrustedDataPolicy(
  args: DeleteTrustedDataPolicyArgs,
  context: ArchestraContext,
): Promise<CallToolResult> {
  const { agent: contextAgent } = context;

  logger.info(
    { agentId: contextAgent.id, policyId: args.id },
    "delete_trusted_data_policy tool called",
  );

  try {
    const success = await TrustedDataPolicyModel.delete(args.id);
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

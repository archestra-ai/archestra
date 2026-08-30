import {
  TOOL_CREATE_BUNDLE_SHORT_NAME,
  TOOL_DELETE_BUNDLE_SHORT_NAME,
  TOOL_EDIT_BUNDLE_SHORT_NAME,
  TOOL_GET_BUNDLE_SHORT_NAME,
  TOOL_LIST_BUNDLES_SHORT_NAME,
} from "@archestra/shared";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { userHasPermission } from "@/auth/utils";
import config from "@/config";
import logger from "@/logging";
import { AgentModel, BundleModel, PluginModel, SkillModel } from "@/models";
import { type Bundle, BundleLocalMcpServerSchema } from "@/types";
import {
  catchError,
  defineArchestraTool,
  defineArchestraTools,
  errorResult,
  structuredSuccessResult,
} from "./helpers";
import type { ArchestraContext } from "./types";

const BundleOutputSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string(),
  name: z.string(),
  description: z.string(),
  mcpGatewayId: z.string().uuid().nullable(),
  skillIds: z.array(z.string().uuid()),
  pluginIds: z.array(z.string().uuid()),
  localMcpServers: z.array(BundleLocalMcpServerSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const BundleFieldsSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1_000).default(""),
  mcp_gateway_id: z.string().uuid().nullable().default(null),
  skill_ids: z.array(z.string().uuid()).max(500).default([]),
  plugin_ids: z.array(z.string().uuid()).max(50).default([]),
  local_mcp_servers: z
    .array(BundleLocalMcpServerSchema.omit({ id: true }))
    .max(50)
    .default([]),
});

const EditBundleArgsSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(1_000).optional(),
    mcp_gateway_id: z.string().uuid().nullable().optional(),
    skill_ids: z.array(z.string().uuid()).max(500).optional(),
    plugin_ids: z.array(z.string().uuid()).max(50).optional(),
    local_mcp_servers: z
      .array(
        BundleLocalMcpServerSchema.extend({ id: z.string().uuid().optional() }),
      )
      .max(50)
      .optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).some((key) => key !== "id"), {
    message: "At least one field to update is required",
  });

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: TOOL_CREATE_BUNDLE_SHORT_NAME,
    title: "Create Bundle",
    description:
      "Create an organization bundle containing skills, plugins, and an optional MCP gateway.",
    schema: BundleFieldsSchema.strict(),
    outputSchema: z.object({ bundle: BundleOutputSchema }),
    async handler({ args, context }) {
      const disabled = bundlesDisabledError();
      if (disabled) return disabled;
      return handleCreate({ args, context });
    },
  }),
  defineArchestraTool({
    shortName: TOOL_GET_BUNDLE_SHORT_NAME,
    title: "Get Bundle",
    description: "Get one bundle by ID.",
    schema: z.object({ id: z.string().uuid() }).strict(),
    outputSchema: z.object({ bundle: BundleOutputSchema }),
    async handler({ args, context }) {
      const disabled = bundlesDisabledError();
      if (disabled) return disabled;
      return handleGet({ args, context });
    },
  }),
  defineArchestraTool({
    shortName: TOOL_LIST_BUNDLES_SHORT_NAME,
    title: "List Bundles",
    description: "List bundles in the active organization.",
    schema: z.object({}).strict(),
    outputSchema: z.object({ bundles: z.array(BundleOutputSchema) }),
    async handler({ context }) {
      const disabled = bundlesDisabledError();
      if (disabled) return disabled;
      return handleList(context);
    },
  }),
  defineArchestraTool({
    shortName: TOOL_EDIT_BUNDLE_SHORT_NAME,
    title: "Edit Bundle",
    description:
      "Update a bundle. Supplied skill and plugin arrays replace existing membership.",
    schema: EditBundleArgsSchema,
    outputSchema: z.object({ bundle: BundleOutputSchema }),
    async handler({ args, context }) {
      const disabled = bundlesDisabledError();
      if (disabled) return disabled;
      return handleEdit({ args, context });
    },
  }),
  defineArchestraTool({
    shortName: TOOL_DELETE_BUNDLE_SHORT_NAME,
    title: "Delete Bundle",
    description:
      "Delete a bundle and revoke its linked marketplace installations.",
    schema: z.object({ id: z.string().uuid() }).strict(),
    outputSchema: z.object({ success: z.literal(true), id: z.string().uuid() }),
    async handler({ args, context }) {
      const disabled = bundlesDisabledError();
      if (disabled) return disabled;
      return handleDelete({ args, context });
    },
  }),
] as const);

export const toolEntries = registry.toolEntries;
export const tools = registry.tools;

function bundlesDisabledError() {
  if (config.bundles.enabled) return null;
  return errorResult("Bundles are not enabled on this deployment.");
}

async function handleCreate(params: {
  args: z.infer<typeof BundleFieldsSchema>;
  context: ArchestraContext;
}): Promise<CallToolResult> {
  const { args, context } = params;
  logger.info({ agentId: context.agent.id }, "create_bundle called");
  if (!context.organizationId)
    return errorResult("Organization context unavailable.");
  try {
    const invalid = await validateReferences({
      context,
      skillIds: args.skill_ids,
      pluginIds: args.plugin_ids,
      mcpGatewayId: args.mcp_gateway_id,
    });
    if (invalid) return invalid;
    const bundle = await BundleModel.create({
      organizationId: context.organizationId,
      name: args.name,
      description: args.description,
      mcpGatewayId: args.mcp_gateway_id,
      skillIds: args.skill_ids,
      pluginIds: args.plugin_ids,
      localMcpServers: args.local_mcp_servers,
    });
    return bundleResult(bundle, "Created");
  } catch (error) {
    return catchError(error, "creating bundle");
  }
}

async function handleGet(params: {
  args: { id: string };
  context: ArchestraContext;
}): Promise<CallToolResult> {
  if (!params.context.organizationId) {
    return errorResult("Organization context unavailable.");
  }
  const bundle = await BundleModel.findById({
    id: params.args.id,
    organizationId: params.context.organizationId,
  });
  if (!bundle) return errorResult(`Bundle ${params.args.id} not found.`);
  return bundleResult(bundle, "Found");
}

async function handleList(context: ArchestraContext): Promise<CallToolResult> {
  if (!context.organizationId)
    return errorResult("Organization context unavailable.");
  try {
    const bundles = await BundleModel.findAllByOrganization(
      context.organizationId,
    );
    return structuredSuccessResult(
      { bundles: bundles.map(serializeBundle) },
      bundles.length === 0
        ? "No bundles found."
        : `Found ${bundles.length} bundle(s).`,
    );
  } catch (error) {
    return catchError(error, "listing bundles");
  }
}

async function handleEdit(params: {
  args: z.infer<typeof EditBundleArgsSchema>;
  context: ArchestraContext;
}): Promise<CallToolResult> {
  if (!params.context.organizationId) {
    return errorResult("Organization context unavailable.");
  }
  const {
    id,
    mcp_gateway_id,
    skill_ids,
    plugin_ids,
    local_mcp_servers,
    ...fields
  } = params.args;
  try {
    const invalid = await validateReferences({
      context: params.context,
      skillIds: skill_ids,
      pluginIds: plugin_ids,
      mcpGatewayId: mcp_gateway_id,
    });
    if (invalid) return invalid;
    const bundle = await BundleModel.update({
      id,
      organizationId: params.context.organizationId,
      ...fields,
      ...(mcp_gateway_id !== undefined ? { mcpGatewayId: mcp_gateway_id } : {}),
      ...(skill_ids !== undefined ? { skillIds: skill_ids } : {}),
      ...(plugin_ids !== undefined ? { pluginIds: plugin_ids } : {}),
      ...(local_mcp_servers !== undefined
        ? { localMcpServers: local_mcp_servers }
        : {}),
    });
    if (!bundle) return errorResult(`Bundle ${id} not found.`);
    return bundleResult(bundle, "Updated");
  } catch (error) {
    return catchError(error, "updating bundle");
  }
}

async function handleDelete(params: {
  args: { id: string };
  context: ArchestraContext;
}): Promise<CallToolResult> {
  if (!params.context.organizationId) {
    return errorResult("Organization context unavailable.");
  }
  try {
    const deleted = await BundleModel.delete({
      id: params.args.id,
      organizationId: params.context.organizationId,
    });
    if (!deleted) {
      return errorResult(`Bundle ${params.args.id} not found.`);
    }
    return structuredSuccessResult(
      { success: true, id: params.args.id },
      `Deleted bundle ${params.args.id}.`,
    );
  } catch (error) {
    return catchError(error, "deleting bundle");
  }
}

function bundleResult(
  bundle: Bundle,
  verb: string,
): ReturnType<typeof structuredSuccessResult> {
  return structuredSuccessResult(
    { bundle: serializeBundle(bundle) },
    `${verb} bundle "${bundle.name}" (${bundle.id}).`,
  );
}

function serializeBundle(bundle: Bundle) {
  return {
    ...bundle,
    createdAt: bundle.createdAt.toISOString(),
    updatedAt: bundle.updatedAt.toISOString(),
  };
}

async function validateReferences(params: {
  context: ArchestraContext;
  skillIds?: string[];
  pluginIds?: string[];
  mcpGatewayId?: string | null;
}): Promise<CallToolResult | null> {
  const { context } = params;
  const organizationId = context.organizationId;
  const userId = context.userId;
  if (!organizationId || !userId) {
    return errorResult("Organization context unavailable.");
  }
  if (params.skillIds !== undefined) {
    const skillIds = [...new Set(params.skillIds)];
    const skills = await SkillModel.findByIds(skillIds);
    if (
      skills.length !== skillIds.length ||
      skills.some((skill) => skill.organizationId !== context.organizationId)
    ) {
      return errorResult("One or more skills were not found.");
    }
  }
  if (params.pluginIds !== undefined) {
    const pluginIds = [...new Set(params.pluginIds)];
    if (pluginIds.length > 0) {
      const [canRead, canAdmin] = await Promise.all([
        userHasPermission(userId, organizationId, "plugin", "read"),
        userHasPermission(userId, organizationId, "plugin", "admin"),
      ]);
      if (!canRead || !canAdmin) {
        return errorResult("One or more approved plugins were not found.");
      }
      const plugins = await PluginModel.findApprovedByIds({
        ids: pluginIds,
        organizationId,
      });
      if (plugins.length !== pluginIds.length) {
        return errorResult("One or more approved plugins were not found.");
      }
    }
  }
  if (params.mcpGatewayId) {
    const gateway = await AgentModel.findById(
      params.mcpGatewayId,
      context.userId,
      false,
    );
    if (
      !gateway ||
      gateway.organizationId !== context.organizationId ||
      !["mcp_gateway", "profile"].includes(gateway.agentType)
    ) {
      return errorResult("MCP gateway not found.");
    }
  }
  return null;
}

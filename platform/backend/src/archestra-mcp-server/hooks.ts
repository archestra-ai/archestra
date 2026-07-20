import {
  TOOL_CREATE_HOOK_SHORT_NAME,
  TOOL_DELETE_HOOK_SHORT_NAME,
  TOOL_LIST_HOOKS_SHORT_NAME,
  TOOL_UPDATE_HOOK_SHORT_NAME,
} from "@archestra/shared";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import logger from "@/logging";
import { AgentModel, HookFileModel } from "@/models";
import { UuidIdSchema } from "@/types";
import type { HookFile } from "@/types/hook";
import {
  HookEventSchema,
  HookFileNameSchema,
  HookRequirementsSchema,
} from "@/types/hook";
import {
  catchError,
  defineArchestraTool,
  defineArchestraTools,
  errorResult,
  structuredSuccessResult,
} from "./helpers";
import type { ArchestraContext } from "./types";

// === Constants ===

/**
 * Shared contract blurb reused across tool descriptions so an agent (or an
 * external client like Claude Code connected through the gateway) can author
 * working hook scripts without extra lookups. Keep in sync with
 * `hooks/hook-runner.ts` and `hooks/hook-dispatcher-service.ts`.
 */
const HOOK_CONTRACT = [
  "Hooks are Python (.py) or shell (.sh) scripts that run in the conversation sandbox when a lifecycle event fires:",
  "session_start (conversation start; stdout on exit 0 is injected into the agent's context),",
  "pre_tool_use (before each tool call; exit 2 blocks the call with stderr as the reason),",
  "post_tool_use (after each tool call; exit 2 appends stderr to the tool result as [hook feedback]).",
  "Scripts receive one JSON payload on stdin with hook_event_name, session_id, cwd, permission_mode plus event-specific fields",
  "(session_start: source, model; pre_tool_use: tool_name, tool_input; post_tool_use: tool_name, tool_input, tool_response).",
  "Field names match Claude Code hook payloads. Scripts time out after 30 seconds and fail open.",
].join(" ");

const HookOutputItemSchema = z.object({
  id: z.string().describe("The hook ID."),
  agentId: z.string().describe("The agent the hook belongs to."),
  event: HookEventSchema.describe("The lifecycle event the hook fires on."),
  fileName: z
    .string()
    .describe(
      "The script file name (.py or .sh); also the execution-order key within an event.",
    ),
  content: z.string().describe("The script content."),
  requirements: z
    .array(z.string())
    .describe("Python dependencies installed before a .py hook runs."),
  enabled: z.boolean().describe("Whether the hook currently fires."),
  createdAt: z.string().describe("ISO timestamp when the hook was created."),
  updatedAt: z
    .string()
    .describe("ISO timestamp when the hook was last updated."),
});

const ListHooksToolArgsSchema = z
  .object({
    agent_id: UuidIdSchema.describe("The ID of the agent whose hooks to list."),
  })
  .strict();

const CreateHookToolArgsSchema = z
  .object({
    agent_id: UuidIdSchema.describe("The ID of the agent to add the hook to."),
    event: HookEventSchema.describe(
      "The lifecycle event the hook fires on: session_start, pre_tool_use, or post_tool_use.",
    ),
    file_name: HookFileNameSchema.describe(
      "Plain script file name ending in .py or .sh, e.g. check.py. Unique per (agent, event); hooks on the same event run in file-name order.",
    ),
    content: z
      .string()
      .min(1)
      .max(65_536)
      .describe("The script content. It receives the JSON payload on stdin."),
    requirements: HookRequirementsSchema.optional().describe(
      "Optional Python dependencies (pip requirement strings) installed before a .py hook runs.",
    ),
    enabled: z
      .boolean()
      .optional()
      .describe("Whether the hook fires. Defaults to true."),
  })
  .strict();

const UpdateHookToolArgsSchema = z
  .object({
    id: UuidIdSchema.describe("The ID of the hook to update."),
    event: HookEventSchema.optional().describe("Optional new lifecycle event."),
    file_name: HookFileNameSchema.optional().describe(
      "Optional new script file name ending in .py or .sh.",
    ),
    content: z
      .string()
      .min(1)
      .max(65_536)
      .optional()
      .describe("Optional new script content."),
    requirements: HookRequirementsSchema.optional().describe(
      "Optional replacement list of Python dependencies.",
    ),
    enabled: z
      .boolean()
      .optional()
      .describe("Optionally enable or disable the hook."),
  })
  .strict()
  .superRefine((args, ctx) => {
    const { id: _id, ...fields } = args;
    if (Object.values(fields).every((value) => value === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["id"],
        message: "Provide at least one field to update besides the id.",
      });
    }
  });

const DeleteHookToolArgsSchema = z
  .object({
    id: UuidIdSchema.describe("The ID of the hook to delete."),
  })
  .strict();

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: TOOL_LIST_HOOKS_SHORT_NAME,
    title: "List Hooks",
    description: `List an agent's lifecycle hooks. ${HOOK_CONTRACT}`,
    schema: ListHooksToolArgsSchema,
    outputSchema: z.object({ hooks: z.array(HookOutputItemSchema) }),
    async handler({ args, context }) {
      return handleListHooks({ args, context });
    },
  }),
  defineArchestraTool({
    shortName: TOOL_CREATE_HOOK_SHORT_NAME,
    title: "Create Hook",
    description: `Create a lifecycle hook on an agent. ${HOOK_CONTRACT}`,
    schema: CreateHookToolArgsSchema,
    outputSchema: z.object({ hook: HookOutputItemSchema }),
    async handler({ args, context }) {
      return handleCreateHook({ args, context });
    },
  }),
  defineArchestraTool({
    shortName: TOOL_UPDATE_HOOK_SHORT_NAME,
    title: "Update Hook",
    description:
      "Update an existing lifecycle hook: its event, file name, script content, Python requirements, or enabled state. At least one field besides the id must be provided.",
    schema: UpdateHookToolArgsSchema,
    outputSchema: z.object({ hook: HookOutputItemSchema }),
    async handler({ args, context }) {
      return handleUpdateHook({ args, context });
    },
  }),
  defineArchestraTool({
    shortName: TOOL_DELETE_HOOK_SHORT_NAME,
    title: "Delete Hook",
    description: "Delete a lifecycle hook by ID.",
    schema: DeleteHookToolArgsSchema,
    outputSchema: z.object({ success: z.literal(true), id: z.string() }),
    async handler({ args, context }) {
      return handleDeleteHook({ args, context });
    },
  }),
] as const);

// === Exports ===

export const toolEntries = registry.toolEntries;

export const tools = registry.tools;

// === Internal helpers ===

/**
 * Agent-in-org guard mirroring the REST routes' `requireAgentInOrg`: a hook
 * can only be attached to (or listed for) an agent in the caller's org, and
 * cross-org agents read as not found.
 */
async function assertAgentInOrg(
  agentId: string,
  organizationId: string,
): Promise<CallToolResult | null> {
  const agentOrgId = await AgentModel.findOrganizationId(agentId);
  if (agentOrgId !== organizationId) {
    return errorResult(`Agent with ID ${agentId} not found.`);
  }
  return null;
}

function serializeHook(hook: HookFile) {
  return {
    id: hook.id,
    agentId: hook.agentId,
    event: hook.event,
    fileName: hook.fileName,
    content: hook.content,
    requirements: hook.requirements,
    enabled: hook.enabled,
    createdAt: hook.createdAt.toISOString(),
    updatedAt: hook.updatedAt.toISOString(),
  };
}

async function handleListHooks(params: {
  args: z.infer<typeof ListHooksToolArgsSchema>;
  context: ArchestraContext;
}): Promise<CallToolResult> {
  const { args, context } = params;

  if (!context.organizationId) {
    return errorResult("User context not available.");
  }

  try {
    const denied = await assertAgentInOrg(
      args.agent_id,
      context.organizationId,
    );
    if (denied) {
      return denied;
    }

    const hooks = await HookFileModel.listByAgent(
      args.agent_id,
      context.organizationId,
    );
    return structuredSuccessResult({ hooks: hooks.map(serializeHook) });
  } catch (error) {
    return catchError(error, "listing hooks");
  }
}

async function handleCreateHook(params: {
  args: z.infer<typeof CreateHookToolArgsSchema>;
  context: ArchestraContext;
}): Promise<CallToolResult> {
  const { args, context } = params;
  logger.info(
    { agentId: context.agent.id, targetAgentId: args.agent_id },
    "create_hook tool called",
  );

  if (!context.organizationId) {
    return errorResult("User context not available.");
  }

  try {
    const denied = await assertAgentInOrg(
      args.agent_id,
      context.organizationId,
    );
    if (denied) {
      return denied;
    }

    const hook = await HookFileModel.create({
      organizationId: context.organizationId,
      agentId: args.agent_id,
      event: args.event,
      fileName: args.file_name,
      content: args.content,
      requirements: args.requirements ?? [],
      ...(args.enabled !== undefined && { enabled: args.enabled }),
    });
    return structuredSuccessResult({ hook: serializeHook(hook) });
  } catch (error) {
    return catchError(error, "creating the hook");
  }
}

async function handleUpdateHook(params: {
  args: z.infer<typeof UpdateHookToolArgsSchema>;
  context: ArchestraContext;
}): Promise<CallToolResult> {
  const { args, context } = params;
  logger.info(
    { agentId: context.agent.id, hookId: args.id },
    "update_hook tool called",
  );

  if (!context.organizationId) {
    return errorResult("User context not available.");
  }

  try {
    const hook = await HookFileModel.update({
      id: args.id,
      organizationId: context.organizationId,
      data: {
        ...(args.event !== undefined && { event: args.event }),
        ...(args.file_name !== undefined && { fileName: args.file_name }),
        ...(args.content !== undefined && { content: args.content }),
        ...(args.requirements !== undefined && {
          requirements: args.requirements,
        }),
        ...(args.enabled !== undefined && { enabled: args.enabled }),
      },
    });
    if (!hook) {
      return errorResult(`Hook with ID ${args.id} not found.`);
    }
    return structuredSuccessResult({ hook: serializeHook(hook) });
  } catch (error) {
    return catchError(error, "updating the hook");
  }
}

async function handleDeleteHook(params: {
  args: z.infer<typeof DeleteHookToolArgsSchema>;
  context: ArchestraContext;
}): Promise<CallToolResult> {
  const { args, context } = params;
  logger.info(
    { agentId: context.agent.id, hookId: args.id },
    "delete_hook tool called",
  );

  if (!context.organizationId) {
    return errorResult("User context not available.");
  }

  try {
    const deleted = await HookFileModel.delete(args.id, context.organizationId);
    if (!deleted) {
      return errorResult(`Hook with ID ${args.id} not found.`);
    }
    return structuredSuccessResult({ success: true, id: args.id });
  } catch (error) {
    return catchError(error, "deleting the hook");
  }
}

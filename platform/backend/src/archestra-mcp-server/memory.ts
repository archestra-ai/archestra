import {
  PROJECT_MEMORY_MAX_ENTRY_LENGTH,
  TOOL_DELETE_MEMORY_SHORT_NAME,
  TOOL_LIST_MEMORIES_SHORT_NAME,
  TOOL_SAVE_MEMORY_SHORT_NAME,
  TOOL_UPDATE_MEMORY_SHORT_NAME,
} from "@archestra/shared";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { projectService } from "@/services/project";
import { resolveProjectFileScope } from "@/skills-sandbox/project-file-scope";
import { SkillSandboxError } from "@/skills-sandbox/types";
import { ApiError } from "@/types";
import {
  defineArchestraTool,
  defineArchestraTools,
  errorResult,
  structuredSuccessResult,
  successResult,
} from "./helpers";
import type { ArchestraContext } from "./types";

/**
 * Project memory tools.
 *
 * A memory is a short durable note scoped to a project ("the launch is July
 * 15", "prefers concise answers"). Saved memories are injected into the system
 * prompt of every chat in the project, so the assistant carries them across
 * conversations; users manage the same entries in the project's Memory panel.
 *
 * The target project is resolved from the current conversation (a chat inside
 * a project) — the caller's project access is re-checked on every call, like
 * the project file tools. Stateless callers with no conversation (e.g. an
 * external MCP Gateway client) must pass `project_id` explicitly; it is
 * validated against the same per-project access check and always requires an
 * authenticated user.
 */

const ProjectIdArg = z
  .string()
  .uuid()
  .optional()
  .describe(
    "Optional project id. Omit inside a project chat (the chat's project is " +
      "used). Required when calling from outside a conversation, e.g. via " +
      "the MCP Gateway.",
  );

const SaveMemorySchema = z.object({
  content: z
    .string()
    .trim()
    .min(1)
    .max(PROJECT_MEMORY_MAX_ENTRY_LENGTH)
    .describe(
      "The memory to save: one short, self-contained fact or preference " +
        `(max ${PROJECT_MEMORY_MAX_ENTRY_LENGTH} characters). Not a place ` +
        "for documents or long notes.",
    ),
  project_id: ProjectIdArg,
});

const ListMemoriesSchema = z.object({
  project_id: ProjectIdArg,
});

const UpdateMemorySchema = z.object({
  memory_id: z
    .string()
    .uuid()
    .describe("The id of the memory to update, as returned by list_memories."),
  content: z
    .string()
    .trim()
    .min(1)
    .max(PROJECT_MEMORY_MAX_ENTRY_LENGTH)
    .describe("The replacement content for the memory."),
  project_id: ProjectIdArg,
});

const DeleteMemorySchema = z.object({
  memory_id: z
    .string()
    .uuid()
    .describe("The id of the memory to delete, as returned by list_memories."),
  project_id: ProjectIdArg,
});

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: TOOL_SAVE_MEMORY_SHORT_NAME,
    title: "Save Memory",
    description:
      "Save a memory to the current project — a short durable fact or " +
      "preference worth carrying into the project's future conversations " +
      "(a decision, a deadline, how the user likes things done). Use it when " +
      "the user asks you to remember something, or states something clearly " +
      "durable. Only works in a project: in a non-project chat, tell the " +
      "user to move the chat into a project first. When the project's " +
      "memory is full, delete or consolidate existing memories instead.",
    schema: SaveMemorySchema,
    async handler({ args, context }) {
      return withMemoryProject(
        { context, projectId: args.project_id },
        async ({ projectId, userId, organizationId }) => {
          const memory = await projectService.createMemory({
            id: projectId,
            organizationId,
            userId,
            content: args.content,
          });
          return structuredSuccessResult(
            { id: memory.id, content: memory.content },
            `Memory saved (id: ${memory.id}).`,
          );
        },
      );
    },
  }),
  defineArchestraTool({
    shortName: TOOL_LIST_MEMORIES_SHORT_NAME,
    title: "List Memories",
    description:
      "List the current project's saved memories (newest first), with the " +
      "ids update_memory / delete_memory take. Project memories are already " +
      "in your system prompt during a project chat; call this when you need " +
      "ids to edit or delete entries, or when calling from outside a chat.",
    schema: ListMemoriesSchema,
    async handler({ args, context }) {
      return withMemoryProject(
        { context, projectId: args.project_id },
        async ({ projectId, userId, organizationId }) => {
          const memories = await projectService.listMemories({
            id: projectId,
            organizationId,
            userId,
          });
          if (memories.length === 0) {
            return successResult("This project has no saved memories.");
          }
          const lines = memories.map(
            (memory) => `- [${memory.id}] ${memory.content}`,
          );
          return structuredSuccessResult(
            {
              memories: memories.map((memory) => ({
                id: memory.id,
                content: memory.content,
                createdAt: memory.createdAt.toISOString(),
              })),
            },
            `${memories.length} saved ${memories.length === 1 ? "memory" : "memories"} (newest first):\n${lines.join("\n")}`,
          );
        },
      );
    },
  }),
  defineArchestraTool({
    shortName: TOOL_UPDATE_MEMORY_SHORT_NAME,
    title: "Update Memory",
    description:
      "Replace the content of one of the current project's memories (by id, " +
      "from list_memories or the memory block in your system prompt). Use it " +
      "to correct or consolidate what is already remembered.",
    schema: UpdateMemorySchema,
    async handler({ args, context }) {
      return withMemoryProject(
        { context, projectId: args.project_id },
        async ({ projectId, userId, organizationId }) => {
          await projectService.updateMemory({
            id: projectId,
            memoryId: args.memory_id,
            organizationId,
            userId,
            content: args.content,
          });
          return successResult(`Memory ${args.memory_id} updated.`);
        },
      );
    },
  }),
  defineArchestraTool({
    shortName: TOOL_DELETE_MEMORY_SHORT_NAME,
    title: "Delete Memory",
    description:
      "Delete one of the current project's memories (by id, from " +
      "list_memories or the memory block in your system prompt). Use it when " +
      "the user asks you to forget something, or when a memory is stale or " +
      "superseded.",
    schema: DeleteMemorySchema,
    async handler({ args, context }) {
      return withMemoryProject(
        { context, projectId: args.project_id },
        async ({ projectId, userId, organizationId }) => {
          await projectService.deleteMemory({
            id: projectId,
            memoryId: args.memory_id,
            organizationId,
            userId,
          });
          return successResult(`Memory ${args.memory_id} deleted.`);
        },
      );
    },
  }),
]);

export const toolEntries = registry.toolEntries;
export const tools = registry.tools;

// === Internal helpers ===

/**
 * Resolve the target project and run `fn` against it, mapping resolution and
 * service failures to tool error results. An explicit `projectId` wins;
 * otherwise the current conversation's project is used. The service re-checks
 * the caller's per-project access on every call (fails closed), so this
 * helper only needs to establish WHICH project is meant.
 */
async function withMemoryProject(
  params: { context: ArchestraContext; projectId: string | undefined },
  fn: (scope: {
    projectId: string;
    userId: string;
    organizationId: string;
  }) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const { context, projectId } = params;
  const { organizationId, userId } = context;
  if (!organizationId || !userId) {
    return errorResult(
      "This tool requires an authenticated user session (org/team tokens cannot manage project memory).",
    );
  }

  let targetProjectId = projectId;
  if (!targetProjectId) {
    let scope: Awaited<ReturnType<typeof resolveProjectFileScope>>;
    try {
      scope = await resolveProjectFileScope({
        conversationId: context.conversationId,
        userId,
        organizationId,
      });
    } catch (error) {
      if (error instanceof SkillSandboxError) {
        return errorResult(error.message);
      }
      throw error;
    }
    if (!scope) {
      return errorResult(
        "This conversation is not part of a project, so it has no memory. " +
          "Suggest moving the chat into a project, or pass project_id explicitly.",
      );
    }
    targetProjectId = scope.projectId;
  }

  try {
    return await fn({
      projectId: targetProjectId,
      userId,
      organizationId,
    });
  } catch (error) {
    // ApiError messages are user-actionable (404 no access / 409 memory cap /
    // 400 validation) and safe to surface to the model.
    if (error instanceof ApiError) {
      return errorResult(error.message);
    }
    throw error;
  }
}

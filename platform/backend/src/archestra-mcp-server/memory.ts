import {
  TOOL_DELETE_MEMORY_SHORT_NAME,
  TOOL_RECALL_MEMORIES_SHORT_NAME,
  TOOL_SAVE_MEMORY_SHORT_NAME,
} from "@shared";
import { z } from "zod";
import logger from "@/logging";
import { MemoryItemModel } from "@/models";
import {
  catchError,
  defineArchestraTool,
  defineArchestraTools,
  errorResult,
  successResult,
} from "./helpers";
import type { ArchestraContext } from "./types";

const SaveMemorySchema = z
  .object({
    content: z
      .string()
      .min(1)
      .max(10000)
      .describe(
        "The memory content to save. Write this as a clear, self-contained " +
          "statement the agent can use later — e.g. 'The user prefers " +
          "TypeScript over JavaScript' rather than raw conversation excerpts.",
      ),
    namespace: z
      .string()
      .trim()
      .max(200)
      .optional()
      .describe(
        "Optional grouping key (e.g. 'preferences', 'project-context'). " +
        "Omit for general memories.",
      ),
  })
  .strict();

const RecallMemoriesSchema = z
  .object({
    namespace: z
      .string()
      .trim()
      .max(200)
      .optional()
      .describe(
        "Filter to memories in this namespace only. Omit to recall all.",
      ),
  })
  .strict();

const DeleteMemorySchema = z
  .object({
    id: z.string().describe("The ID of the memory to delete."),
  })
  .strict();

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: TOOL_SAVE_MEMORY_SHORT_NAME,
    title: "Save Memory",
    description:
      "Persist a fact, preference, or piece of context so the agent can " +
      "recall it in future conversations. Use this when the user shares " +
      "something worth remembering — their name, project details, coding " +
      "style, recurring requests, etc.",
    schema: SaveMemorySchema,
    async handler({ args, context }) {
      const ctx = requireUserContext(context);
      if (!ctx) {
        return errorResult("This tool requires an authenticated user session.");
      }

      try {
        const item = await MemoryItemModel.create({
          organizationId: ctx.organizationId,
          userId: ctx.userId,
          content: args.content,
          namespace: args.namespace ?? null,
        });

        logger.info(
          {
            organizationId: ctx.organizationId,
            userId: ctx.userId,
            memoryId: item.id,
            namespace: args.namespace,
          },
          "[Memory] Saved memory",
        );

        return successResult(
          `Saved memory (id: ${item.id}).`,
        );
      } catch (error) {
        return catchError(error, "saving memory");
      }
    },
  }),
  defineArchestraTool({
    shortName: TOOL_RECALL_MEMORIES_SHORT_NAME,
    title: "Recall Memories",
    description:
      "List saved memories for the current user. Call this at the start " +
      "of a conversation when you need context about the user that the " +
      "system prompt may not include, or when filtering by namespace.",
    schema: RecallMemoriesSchema,
    async handler({ args, context }) {
      const ctx = requireUserContext(context);
      if (!ctx) {
        return errorResult("This tool requires an authenticated user session.");
      }

      try {
        const items = await MemoryItemModel.findByUser({
          organizationId: ctx.organizationId,
          userId: ctx.userId,
          namespace: args.namespace,
        });

        if (items.length === 0) {
          return successResult("No saved memories found.");
        }

        const lines = items.map(
          (item) =>
            `[${item.id}] ${item.namespace ? `{${item.namespace}} ` : ""}${item.content}`,
        );

        return successResult(
          `Found ${items.length} memory/memories:\n${lines.join("\n")}`,
        );
      } catch (error) {
        return catchError(error, "recalling memories");
      }
    },
  }),
  defineArchestraTool({
    shortName: TOOL_DELETE_MEMORY_SHORT_NAME,
    title: "Delete Memory",
    description:
      "Delete a saved memory by its ID. Use recall_memories first to " +
      "find the ID.",
    schema: DeleteMemorySchema,
    async handler({ args, context }) {
      const ctx = requireUserContext(context);
      if (!ctx) {
        return errorResult("This tool requires an authenticated user session.");
      }

      try {
        const existing = await MemoryItemModel.findById(args.id);
        if (
          !existing ||
          existing.organizationId !== ctx.organizationId ||
          existing.userId !== ctx.userId
        ) {
          return errorResult("Memory not found.");
        }

        const deleted = await MemoryItemModel.delete(args.id);
        if (!deleted) {
          return errorResult("Memory not found.");
        }

        return successResult(`Deleted memory ${args.id}.`);
      } catch (error) {
        return catchError(error, "deleting memory");
      }
    },
  }),
] as const);

// ===== Internal helpers =====

interface UserContext {
  organizationId: string;
  userId: string;
}

function requireUserContext(context: ArchestraContext): UserContext | null {
  if (!context.organizationId || !context.userId) return null;
  return { organizationId: context.organizationId, userId: context.userId };
}

export const toolEntries = registry.toolEntries;
export const tools = registry.tools;

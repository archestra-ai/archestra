import {
  CursorQuerySchema,
  PaginationQuerySchema,
  TOOL_GET_LLM_INTERACTION_SHORT_NAME,
  TOOL_GET_LLM_SESSION_LOGS_SHORT_NAME,
  TOOL_LIST_LLM_INTERACTIONS_SHORT_NAME,
  TOOL_LIST_LLM_SESSIONS_SHORT_NAME,
} from "@archestra/shared";
import { z } from "zod";
import { userHasPermission } from "@/auth/utils";
import InteractionModel from "@/models/interaction";
import { UuidIdSchema } from "@/types";
import {
  catchError,
  defineArchestraTool,
  defineArchestraTools,
  errorResult,
  structuredSuccessResult,
} from "./helpers";
import type { ArchestraContext } from "./types";

const FiltersSchema = z.object({
  profile_id: UuidIdSchema.optional(),
  user_id: z.string().optional(),
  start_date: z.string().datetime().optional(),
  end_date: z.string().datetime().optional(),
});

const InteractionListArgsSchema = FiltersSchema.extend({
  external_agent_id: z.string().optional(),
  session_id: z.string().optional(),
  limit: PaginationQuerySchema.shape.limit,
  offset: PaginationQuerySchema.shape.offset,
}).strict();

const SessionListArgsSchema = FiltersSchema.extend({
  session_id: z.string().optional(),
  limit: CursorQuerySchema.shape.limit,
  cursor: CursorQuerySchema.shape.cursor,
}).strict();

const SessionLogsArgsSchema = z
  .object({
    session_id: z
      .string()
      .min(1)
      .max(1024)
      .describe(
        "Session ID from list_llm_sessions. For an ungrouped request, use its interaction ID.",
      ),
    limit: PaginationQuerySchema.shape.limit,
    offset: PaginationQuerySchema.shape.offset,
  })
  .strict();

const InteractionArgsSchema = z
  .object({
    interaction_id: UuidIdSchema,
  })
  .strict();

async function logScope(context: ArchestraContext) {
  if (!context.organizationId || !context.userId) return null;
  const canSeeAll = await userHasPermission(
    context.userId,
    context.organizationId,
    "log",
    "admin",
  );
  return {
    organizationId: context.organizationId,
    ownUserId: canSeeAll ? undefined : context.userId,
  };
}

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: TOOL_LIST_LLM_INTERACTIONS_SHORT_NAME,
    title: "List LLM Interactions",
    description:
      "List paginated LLM request metadata without prompt or response content.",
    schema: InteractionListArgsSchema,
    async handler({ args, context }) {
      try {
        const scope = await logScope(context);
        if (!scope)
          return errorResult("User and organization context required.");
        const result = await InteractionModel.findSummariesPaginated({
          pagination: { limit: args.limit, offset: args.offset },
          sorting: { sortBy: "createdAt", sortDirection: "desc" },
          filters: {
            organizationId: scope.organizationId,
            profileId: args.profile_id,
            externalAgentId: args.external_agent_id,
            userId: scope.ownUserId ?? args.user_id,
            sessionId: args.session_id,
            startDate: args.start_date ? new Date(args.start_date) : undefined,
            endDate: args.end_date ? new Date(args.end_date) : undefined,
          },
        });
        return structuredSuccessResult({ ...result });
      } catch (error) {
        return catchError(error, "listing LLM interactions");
      }
    },
  }),
  defineArchestraTool({
    shortName: TOOL_GET_LLM_INTERACTION_SHORT_NAME,
    title: "Get LLM Interaction",
    description:
      "Fetch a single LLM request log, including its request and response content.",
    schema: InteractionArgsSchema,
    async handler({ args, context }) {
      try {
        const scope = await logScope(context);
        if (!scope)
          return errorResult("User and organization context required.");
        const interaction = await InteractionModel.findById({
          id: args.interaction_id,
          organizationId: scope.organizationId,
        });
        if (
          !interaction ||
          (scope.ownUserId && interaction.userId !== scope.ownUserId)
        ) {
          return errorResult("Interaction not found.");
        }
        return structuredSuccessResult({ interaction });
      } catch (error) {
        return catchError(error, "getting an LLM interaction");
      }
    },
  }),
  defineArchestraTool({
    shortName: TOOL_LIST_LLM_SESSIONS_SHORT_NAME,
    title: "List LLM Sessions",
    description:
      "List paginated gateway sessions with usage summaries and session IDs.",
    schema: SessionListArgsSchema,
    async handler({ args, context }) {
      try {
        const scope = await logScope(context);
        if (!scope)
          return errorResult("User and organization context required.");
        const result = await InteractionModel.getSessionsCursor(
          { limit: args.limit, cursor: args.cursor },
          undefined,
          undefined,
          {
            organizationId: scope.organizationId,
            profileId: args.profile_id,
            userId: scope.ownUserId ?? args.user_id,
            sessionId: args.session_id,
            startDate: args.start_date ? new Date(args.start_date) : undefined,
            endDate: args.end_date ? new Date(args.end_date) : undefined,
          },
        );
        return structuredSuccessResult({ ...result });
      } catch (error) {
        return catchError(error, "listing LLM sessions");
      }
    },
  }),
  defineArchestraTool({
    shortName: TOOL_GET_LLM_SESSION_LOGS_SHORT_NAME,
    title: "Get LLM Session Logs",
    description:
      "Fetch paginated request and response logs for a gateway session.",
    schema: SessionLogsArgsSchema,
    async handler({ args, context }) {
      try {
        const scope = await logScope(context);
        if (!scope)
          return errorResult("User and organization context required.");
        const result = await InteractionModel.findAllPaginated(
          { limit: args.limit, offset: args.offset },
          { sortBy: "createdAt", sortDirection: "asc" },
          undefined,
          undefined,
          {
            organizationId: scope.organizationId,
            userId: scope.ownUserId,
            sessionId: args.session_id,
          },
        );
        return structuredSuccessResult({ ...result });
      } catch (error) {
        return catchError(error, "getting LLM session logs");
      }
    },
  }),
] as const);

export const toolEntries = registry.toolEntries;
export const tools = registry.tools;

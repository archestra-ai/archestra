import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { AgentMemoryModel, TeamModel } from "@/models";
import {
  ApiError,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  MemoryScopeTypeSchema,
  SelectAgentMemorySchema,
  UpsertAgentMemoryBodySchema,
} from "@/types";

const agentMemoryRoutes: FastifyPluginAsyncZod = async (fastify) => {
  /**
   * GET /api/memories
   * Fetch memories scoped to the current user, their teams, or the org.
   * Query param ?scopeType=user|team|org filters further.
   */
  fastify.get(
    "/api/memories",
    {
      schema: {
        operationId: RouteId.GetAgentMemories,
        description:
          "Get agent memories scoped to user, team(s), or organization",
        tags: ["Memories"],
        querystring: z.object({
          scopeType: MemoryScopeTypeSchema.optional().describe(
            "Filter by scope type. When omitted, returns all accessible memories.",
          ),
          scopeId: z
            .string()
            .optional()
            .describe(
              "Specific scope ID (team ID, user ID, or org ID). Defaults to current user/org.",
            ),
        }),
        response: constructResponseSchema(z.array(SelectAgentMemorySchema)),
      },
    },
    async ({ user, organizationId, query }, reply) => {
      const { scopeType, scopeId } = query;

      if (scopeType && scopeId) {
        // Specific scope requested — validate access
        if (scopeType === "user" && scopeId !== user.id) {
          throw new ApiError(
            403,
            "You can only read your own user-scoped memories",
          );
        }
        if (scopeType === "team") {
          const teams = await TeamModel.getUserTeams(user.id);
          const memberOf = teams.some((t) => t.id === scopeId);
          if (!memberOf) {
            throw new ApiError(403, "You are not a member of this team");
          }
        }

        const memories = await AgentMemoryModel.findByScope({
          organizationId,
          scopeType,
          scopeId,
        });
        return reply.send(memories);
      }

      if (scopeType === "org") {
        const memories = await AgentMemoryModel.findByScope({
          organizationId,
          scopeType: "org",
          scopeId: organizationId,
        });
        return reply.send(memories);
      }

      // No specific filter — return everything accessible to this user
      const teams = await TeamModel.getUserTeams(user.id);
      const memories = await AgentMemoryModel.findForContext({
        organizationId,
        userId: user.id,
        teamIds: teams.map((t) => t.id),
      });

      return reply.send(memories);
    },
  );

  /**
   * POST /api/memories
   * Create or update a memory entry (upsert by scope + key).
   */
  fastify.post(
    "/api/memories",
    {
      schema: {
        operationId: RouteId.UpsertAgentMemory,
        description:
          "Create or update a memory entry for a user, team, or organization scope",
        tags: ["Memories"],
        body: UpsertAgentMemoryBodySchema,
        response: constructResponseSchema(SelectAgentMemorySchema),
      },
    },
    async ({ user, organizationId, body }, reply) => {
      const { scopeType, scopeId, key, value } = body;

      // Validate write access to the target scope
      if (scopeType === "user" && scopeId !== user.id) {
        throw new ApiError(
          403,
          "You can only write to your own user-scoped memories",
        );
      }

      if (scopeType === "team") {
        const teams = await TeamModel.getUserTeams(user.id);
        const memberOf = teams.some((t) => t.id === scopeId);
        if (!memberOf) {
          throw new ApiError(403, "You are not a member of this team");
        }
      }

      if (scopeType === "org") {
        // Any org member can write org memories (admins could restrict further if desired)
        if (scopeId !== organizationId) {
          throw new ApiError(400, "Organization scope ID must match your org");
        }
      }

      const memory = await AgentMemoryModel.upsert({
        organizationId,
        scopeType,
        scopeId,
        key,
        value,
      });

      return reply.send(memory);
    },
  );

  /**
   * DELETE /api/memories/:id
   * Delete a specific memory entry.
   */
  fastify.delete(
    "/api/memories/:id",
    {
      schema: {
        operationId: RouteId.DeleteAgentMemory,
        description: "Delete a memory entry by ID",
        tags: ["Memories"],
        params: z.object({
          id: z.string().uuid(),
        }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ user: _user, organizationId, params }, reply) => {
      const { id } = params;

      const deleted = await AgentMemoryModel.delete({ id, organizationId });
      if (!deleted) {
        throw new ApiError(404, "Memory not found");
      }

      return reply.send({ id, deleted: true });
    },
  );
};

export default agentMemoryRoutes;

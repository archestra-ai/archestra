import {
  createPaginatedResponseSchema,
  PaginationQuerySchema,
  RouteId,
} from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { MemberModel } from "@/models";
import { constructResponseSchema, MemberListItemSchema } from "@/types";

const memberRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/members",
    {
      schema: {
        operationId: RouteId.GetMembers,
        description:
          "Get all members of the organization with pagination and optional filters",
        tags: ["Member"],
        querystring: PaginationQuerySchema.extend({
          name: z
            .string()
            .optional()
            .describe(
              "Search by user name or email (case-insensitive partial match)",
            ),
          role: z.string().optional().describe("Filter by exact role name"),
          userId: z
            .string()
            .optional()
            .describe(
              "When set, return only the member with this platform user id",
            ),
        }),
        response: constructResponseSchema(
          createPaginatedResponseSchema(MemberListItemSchema),
        ),
      },
    },
    async (
      { query: { limit, offset, name, role, userId }, organizationId },
      reply,
    ) => {
      return reply.send(
        await MemberModel.findAllPaginated({
          organizationId,
          pagination: { limit, offset },
          name: name || undefined,
          role: role || undefined,
          userId: userId || undefined,
        }),
      );
    },
  );
};

export default memberRoutes;

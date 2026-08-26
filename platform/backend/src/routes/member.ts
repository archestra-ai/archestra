import {
  createPaginatedResponseSchema,
  MAX_BULK_IDS,
  PaginationQuerySchema,
  RouteId,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import logger from "@/logging";
import { MemberModel } from "@/models";
import { removeMemberTarget } from "@/services/member-removal";
import { constructResponseSchema, MemberListItemSchema } from "@/types";

const MemberBulkTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("member"), id: z.string().uuid() }),
  z.object({ kind: z.literal("pendingSignup"), id: z.string().uuid() }),
]);

const BulkDeleteMembersBodySchema = z.object({
  targets: z
    .array(MemberBulkTargetSchema)
    .min(1)
    .max(MAX_BULK_IDS)
    .describe(
      "Member targets to remove. Duplicates are collapsed by kind and id.",
    ),
});

const MemberBulkFailedTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("member"),
    id: z.string().uuid(),
    error: z.string(),
  }),
  z.object({
    kind: z.literal("pendingSignup"),
    id: z.string().uuid(),
    error: z.string(),
  }),
]);

const BulkDeleteMembersResponseSchema = z.object({
  succeeded: z.array(MemberBulkTargetSchema),
  failed: z.array(MemberBulkFailedTargetSchema),
});

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
              'Search by user name or email. Case-insensitive: every whitespace-separated word must appear in the name or the email, in any order, so "Ada Lovelace" also matches "Lovelace, Ada M."',
            ),
          role: z.string().optional().describe("Filter by exact role name"),
        }),
        response: constructResponseSchema(
          createPaginatedResponseSchema(MemberListItemSchema),
        ),
      },
    },
    async ({ query: { limit, offset, name, role }, organizationId }, reply) => {
      return reply.send(
        await MemberModel.findAllPaginated({
          organizationId,
          pagination: { limit, offset },
          name: name || undefined,
          role: role || undefined,
        }),
      );
    },
  );

  fastify.delete(
    "/api/members/bulk",
    {
      schema: {
        operationId: RouteId.BulkDeleteMembers,
        description:
          "Remove accepted members or withdraw pending-signup placeholders in one request. Each target keeps its kind in the partial outcome.",
        tags: ["Member"],
        body: BulkDeleteMembersBodySchema,
        response: constructResponseSchema(BulkDeleteMembersResponseSchema),
      },
    },
    async (request, reply) => {
      const targets = deduplicateTargets(request.body.targets);
      const succeeded: z.infer<typeof MemberBulkTargetSchema>[] = [];
      const failed: z.infer<typeof MemberBulkFailedTargetSchema>[] = [];

      for (const target of targets) {
        try {
          const result = await removeMemberTarget({
            organizationId: request.organizationId,
            actorUserId: request.user.id,
            target,
          });
          if (result.status === "removed") {
            succeeded.push(target);
            continue;
          }
          failed.push({
            ...target,
            error:
              result.status === "self"
                ? "You cannot remove your own account"
                : result.status === "classification_changed"
                  ? "Member signup status changed"
                  : "Member not found",
          });
        } catch (error) {
          logger.error(
            { err: error, target, organizationId: request.organizationId },
            "members bulk delete: unexpected failure",
          );
          failed.push({ ...target, error: "Could not remove this member" });
        }
      }

      if (succeeded.length === 0) {
        // Do not turn an entirely unsuccessful attempt into an audit event.
        request.auditSkip = true;
      } else {
        // The route is organization-context auditable. Keep this batch snapshot
        // deliberately identity-only: it describes the changed targets without
        // retaining member profile data after removal.
        request.auditBefore = { members: succeeded };
        request.auditAfter = { members: [] };
      }

      return reply.send({ succeeded, failed });
    },
  );
};

export default memberRoutes;

function deduplicateTargets(targets: z.infer<typeof MemberBulkTargetSchema>[]) {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = `${target.kind}:${target.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

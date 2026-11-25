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
import { openappaBatteriesService } from "@/openappa/batteries";
import { removeMemberTarget } from "@/services/member-removal";
import {
  assertEligibleNewOwner,
  describeOwnedResources,
} from "@/services/owned-resource-handoff";
import {
  ApiError,
  constructResponseSchema,
  MemberListItemSchema,
} from "@/types";

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
  newOwnerId: z
    .string()
    .optional()
    .describe(
      "User id of an active member who becomes the owner of everything the removed members shared with others (agents, MCP gateways, skills, plugins, MCP registry entries, apps, remote agents). Defaults to you.",
    ),
});

const OwnedResourceKindSchema = z.enum([
  "agent",
  "mcpGateway",
  "skill",
  "plugin",
  "catalog",
  "app",
  "remoteAgent",
]);

const MemberOwnedResourcesSchema = z.object({
  shared: z
    .array(
      z.object({
        id: z.string(),
        kind: OwnedResourceKindSchema,
        name: z.string(),
        sharedWith: z.object({
          organization: z.boolean(),
          teams: z.array(z.string()),
          people: z.number().int(),
        }),
      }),
    )
    .describe("Resources others use. They move to the new owner."),
  personal: z
    .array(z.object({ kind: OwnedResourceKindSchema, count: z.number().int() }))
    .describe(
      "Resources only this member can reach, by kind. They are deleted with the member.",
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

  fastify.get(
    "/api/members/:userId/owned-resources",
    {
      schema: {
        operationId: RouteId.GetMemberOwnedResources,
        description:
          "What a member owns: the resources others use, which move to a new owner when the member is removed, and counts of the personal resources deleted with them.",
        tags: ["Member"],
        params: z.object({ userId: z.string() }),
        response: constructResponseSchema(MemberOwnedResourcesSchema),
      },
    },
    async ({ params, organizationId }, reply) => {
      if (!(await MemberModel.getByUserId(params.userId, organizationId)))
        throw new ApiError(404, "Member not found");
      return reply.send(
        await describeOwnedResources({
          userId: params.userId,
          organizationId,
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
      const { newOwnerId } = request.body;
      if (newOwnerId) {
        const ownerMemberId = await assertEligibleNewOwner({
          candidateId: newOwnerId,
          organizationId: request.organizationId,
        });
        if (
          targets.some(
            (target) =>
              (target.kind === "member" && target.id === ownerMemberId) ||
              (target.kind === "pendingSignup" && target.id === newOwnerId),
          )
        )
          throw new ApiError(
            400,
            "The new owner cannot be someone you are removing",
          );
      }
      const succeeded: z.infer<typeof MemberBulkTargetSchema>[] = [];
      const failed: z.infer<typeof MemberBulkFailedTargetSchema>[] = [];

      for (const target of targets) {
        try {
          const result = await removeMemberTarget({
            organizationId: request.organizationId,
            actorUserId: request.user.id,
            newOwnerId,
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
      // Former members leave the member roster: one recompose for the batch.
      if (succeeded.length > 0)
        await openappaBatteriesService.recompileOrganizations([
          request.organizationId,
        ]);

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

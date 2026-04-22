import {
  calculatePaginationMeta,
  createPaginatedResponseSchema,
  PaginationQuerySchema,
  RouteId,
} from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { canReadMemory } from "@/memory/policy/can-read";
import { memoryReviewService } from "@/memory/review/review-service";
import { MemberModel, MemoryItemModel, TeamModel } from "@/models";
import {
  ApiError,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  MemoryConfidenceBandSchema,
  MemoryKindSchema,
  MemoryPolicyFlagSchema,
  MemoryRejectionReasonSchema,
  MemoryScopeTypeSchema,
  MemoryStatusSchema,
  SelectMemoryItemSchema,
  SupersedeMemoryItemSchema,
  type UpdateMemoryItem,
} from "@/types";

const memoryRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // ===== Read endpoints =====

  fastify.get(
    "/api/memory",
    {
      schema: {
        operationId: RouteId.ListMemory,
        description: "List memory items visible to the requesting user",
        tags: ["Memory"],
        querystring: PaginationQuerySchema.extend({
          scopeType: MemoryScopeTypeSchema.optional(),
          status: MemoryStatusSchema.optional(),
          kind: MemoryKindSchema.optional(),
          search: z.string().optional(),
        }),
        response: constructResponseSchema(
          createPaginatedResponseSchema(SelectMemoryItemSchema),
        ),
      },
    },
    async (
      {
        query: { limit, offset, scopeType, status, kind, search },
        user,
        organizationId,
      },
      reply,
    ) => {
      const [teamIds, member] = await Promise.all([
        TeamModel.getUserTeamIds(user.id),
        MemberModel.getByUserId(user.id, organizationId),
      ]);
      const isOrgAdmin = member?.role?.trim().toLowerCase() === "admin";

      const [items, total] = await Promise.all([
        MemoryItemModel.listForUser({
          userId: user.id,
          organizationId,
          teamIds,
          isOrgAdmin,
          scopeType,
          status,
          kind,
          search,
          limit,
          offset,
        }),
        MemoryItemModel.countForUser({
          userId: user.id,
          organizationId,
          teamIds,
          isOrgAdmin,
          scopeType,
          status,
          kind,
          search,
        }),
      ]);

      return reply.send({
        data: items,
        pagination: calculatePaginationMeta(total, { limit, offset }),
      });
    },
  );

  // stats must be registered before /:id to avoid routing conflict
  fastify.get(
    "/api/memory/stats",
    {
      schema: {
        operationId: RouteId.GetMemoryStats,
        description:
          "Get memory item counts grouped by status for the requesting user",
        tags: ["Memory"],
        response: constructResponseSchema(
          z.object({
            candidate: z.number(),
            approved: z.number(),
            rejected: z.number(),
            archived: z.number(),
          }),
        ),
      },
    },
    async ({ user, organizationId }, reply) => {
      const [teamIds, member] = await Promise.all([
        TeamModel.getUserTeamIds(user.id),
        MemberModel.getByUserId(user.id, organizationId),
      ]);
      const isOrgAdmin = member?.role?.trim().toLowerCase() === "admin";

      const base = { userId: user.id, organizationId, teamIds, isOrgAdmin };
      const [candidate, approved, rejected, archived] = await Promise.all([
        MemoryItemModel.countForUser({ ...base, status: "candidate" }),
        MemoryItemModel.countForUser({ ...base, status: "approved" }),
        MemoryItemModel.countForUser({ ...base, status: "rejected" }),
        MemoryItemModel.countForUser({ ...base, status: "archived" }),
      ]);

      return reply.send({ candidate, approved, rejected, archived });
    },
  );

  fastify.get(
    "/api/memory/pending",
    {
      schema: {
        operationId: RouteId.ListPendingMemory,
        description:
          "List memory candidates pending review by the requesting user",
        tags: ["Memory"],
        querystring: PaginationQuerySchema,
        response: constructResponseSchema(
          createPaginatedResponseSchema(SelectMemoryItemSchema),
        ),
      },
    },
    async ({ query: { limit, offset }, user, organizationId }, reply) => {
      const [teamIds, member] = await Promise.all([
        TeamModel.getUserTeamIds(user.id),
        MemberModel.getByUserId(user.id, organizationId),
      ]);
      const requesterRole = member?.role ?? "";

      const [items, total] = await Promise.all([
        MemoryItemModel.listPendingReview({
          organizationId,
          requesterUserId: user.id,
          requesterRole,
          teamIds,
          limit,
          offset,
        }),
        MemoryItemModel.countPendingReview({
          organizationId,
          requesterUserId: user.id,
          requesterRole,
          teamIds,
        }),
      ]);

      return reply.send({
        data: items,
        pagination: calculatePaginationMeta(total, { limit, offset }),
      });
    },
  );

  fastify.get(
    "/api/memory/:id",
    {
      schema: {
        operationId: RouteId.GetMemory,
        description: "Get a single memory item by ID",
        tags: ["Memory"],
        params: z.object({ id: z.string() }),
        response: constructResponseSchema(SelectMemoryItemSchema),
      },
    },
    async ({ params: { id }, user, organizationId }, reply) => {
      const [item, teamIds, member] = await Promise.all([
        MemoryItemModel.getById({ id, organizationId }),
        TeamModel.getUserTeamIds(user.id),
        MemberModel.getByUserId(user.id, organizationId),
      ]);

      if (!item) {
        throw new ApiError(404, "Memory item not found");
      }

      // Authorization: verify requester can read this specific item's scope
      if (
        !canReadMemory({
          requesterUserId: user.id,
          requesterRole: member?.role,
          organizationId,
          requesterTeamIds: teamIds,
          item,
        })
      ) {
        throw new ApiError(404, "Memory item not found");
      }

      return reply.send(item);
    },
  );

  // ===== Write endpoints =====

  fastify.post(
    "/api/memory",
    {
      schema: {
        operationId: RouteId.CreateMemory,
        description: "Create a new memory candidate",
        tags: ["Memory"],
        body: z.object({
          scopeType: MemoryScopeTypeSchema,
          scopeId: z.string(),
          kind: MemoryKindSchema,
          content: z.string().min(1).max(500),
          policyFlags: z.array(MemoryPolicyFlagSchema).optional(),
          confidenceBand: MemoryConfidenceBandSchema.nullable().optional(),
          expiresAt: z.coerce.date().nullable().optional(),
          language: z.string().optional(),
        }),
        response: constructResponseSchema(SelectMemoryItemSchema),
      },
    },
    async ({ body, user, organizationId }, reply) => {
      const [teamIds, member] = await Promise.all([
        TeamModel.getUserTeamIds(user.id),
        MemberModel.getByUserId(user.id, organizationId),
      ]);

      const created = await memoryReviewService.manualCreate({
        organizationId,
        data: {
          scopeType: body.scopeType,
          scopeId: body.scopeId,
          kind: body.kind,
          content: body.content,
          policyFlags: body.policyFlags,
          confidenceBand: body.confidenceBand ?? undefined,
          expiresAt: body.expiresAt ?? undefined,
          language: body.language,
        },
        requester: { id: user.id, role: member?.role },
        teamIds,
      });

      if (!created) {
        throw new ApiError(
          403,
          "Not authorized to create memory in this scope",
        );
      }

      return reply.send(created);
    },
  );

  fastify.patch(
    "/api/memory/:id",
    {
      schema: {
        operationId: RouteId.UpdateMemory,
        description: "Update a candidate memory item's content or metadata",
        tags: ["Memory"],
        params: z.object({ id: z.string() }),
        body: z.object({
          content: z.string().min(1).max(500).optional(),
          kind: MemoryKindSchema.optional(),
          expiresAt: z.coerce.date().nullable().optional(),
        }),
        response: constructResponseSchema(SelectMemoryItemSchema),
      },
    },
    async ({ params: { id }, body, user, organizationId }, reply) => {
      const [item, teamIds, member] = await Promise.all([
        MemoryItemModel.getById({ id, organizationId }),
        TeamModel.getUserTeamIds(user.id),
        MemberModel.getByUserId(user.id, organizationId),
      ]);

      if (!item) {
        throw new ApiError(404, "Memory item not found");
      }

      // Authorization check before any update
      if (
        !canReadMemory({
          requesterUserId: user.id,
          requesterRole: member?.role,
          organizationId,
          requesterTeamIds: teamIds,
          item,
        })
      ) {
        throw new ApiError(404, "Memory item not found");
      }

      // Drizzle's .set() handles partial updates; cast to satisfy the type contract
      const patch = {} as UpdateMemoryItem;
      if (body.content !== undefined) patch.content = body.content;
      if (body.kind !== undefined) patch.kind = body.kind;
      if ("expiresAt" in body) patch.expiresAt = body.expiresAt;

      const updated = await MemoryItemModel.updateCandidate({
        id,
        organizationId,
        patch,
      });

      if (!updated) {
        throw new ApiError(
          409,
          "Memory item cannot be updated — it may already be approved",
        );
      }

      return reply.send(updated);
    },
  );

  fastify.post(
    "/api/memory/:id/supersede",
    {
      schema: {
        operationId: RouteId.SupersedeMemory,
        description: "Propose a superseding edit to an approved memory item",
        tags: ["Memory"],
        params: z.object({ id: z.string() }),
        body: SupersedeMemoryItemSchema,
        response: constructResponseSchema(SelectMemoryItemSchema),
      },
    },
    async ({ params: { id }, body, user, organizationId }, reply) => {
      const [teamIds, member] = await Promise.all([
        TeamModel.getUserTeamIds(user.id),
        MemberModel.getByUserId(user.id, organizationId),
      ]);

      const created = await memoryReviewService.proposeSupersedingEdit({
        itemId: id,
        organizationId,
        patch: body,
        requester: { id: user.id, role: member?.role },
        teamIds,
      });

      if (!created) {
        throw new ApiError(
          409,
          "Cannot supersede this memory item — it may not be approved or you lack access",
        );
      }

      return reply.send(created);
    },
  );

  fastify.post(
    "/api/memory/:id/approve",
    {
      schema: {
        operationId: RouteId.ApproveMemory,
        description: "Approve a pending memory candidate",
        tags: ["Memory"],
        params: z.object({ id: z.string() }),
        response: constructResponseSchema(SelectMemoryItemSchema),
      },
    },
    async ({ params: { id }, user, organizationId }, reply) => {
      const [teamIds, member] = await Promise.all([
        TeamModel.getUserTeamIds(user.id),
        MemberModel.getByUserId(user.id, organizationId),
      ]);

      const approved = await memoryReviewService.approve({
        itemId: id,
        organizationId,
        reviewer: { id: user.id, role: member?.role },
        teamIds,
      });

      if (!approved) {
        throw new ApiError(
          409,
          "Cannot approve this memory item — it may not be a candidate or you lack access",
        );
      }

      return reply.send(approved);
    },
  );

  fastify.post(
    "/api/memory/:id/reject",
    {
      schema: {
        operationId: RouteId.RejectMemory,
        description: "Reject a pending memory candidate",
        tags: ["Memory"],
        params: z.object({ id: z.string() }),
        body: z.object({
          rejectionReason: MemoryRejectionReasonSchema,
          rejectionComment: z.string().optional(),
        }),
        response: constructResponseSchema(SelectMemoryItemSchema),
      },
    },
    async ({ params: { id }, body, user, organizationId }, reply) => {
      const [teamIds, member] = await Promise.all([
        TeamModel.getUserTeamIds(user.id),
        MemberModel.getByUserId(user.id, organizationId),
      ]);

      const rejected = await memoryReviewService.reject({
        itemId: id,
        organizationId,
        reviewer: { id: user.id, role: member?.role },
        rejectionReason: body.rejectionReason,
        rejectionComment: body.rejectionComment,
        teamIds,
      });

      if (!rejected) {
        throw new ApiError(
          409,
          "Cannot reject this memory item — it may not be a candidate or you lack access",
        );
      }

      return reply.send(rejected);
    },
  );

  fastify.post(
    "/api/memory/:id/archive",
    {
      schema: {
        operationId: RouteId.ArchiveMemory,
        description: "Archive an approved memory item",
        tags: ["Memory"],
        params: z.object({ id: z.string() }),
        response: constructResponseSchema(SelectMemoryItemSchema),
      },
    },
    async ({ params: { id }, user, organizationId }, reply) => {
      const [teamIds, member] = await Promise.all([
        TeamModel.getUserTeamIds(user.id),
        MemberModel.getByUserId(user.id, organizationId),
      ]);

      const archived = await memoryReviewService.archive({
        itemId: id,
        organizationId,
        reviewer: { id: user.id, role: member?.role },
        teamIds,
      });

      if (!archived) {
        throw new ApiError(
          409,
          "Cannot archive this memory item — it may not be approved or you lack access",
        );
      }

      return reply.send(archived);
    },
  );

  fastify.post(
    "/api/memory/:id/unarchive",
    {
      schema: {
        operationId: RouteId.UnarchiveMemory,
        description: "Restore an archived memory item to approved status",
        tags: ["Memory"],
        params: z.object({ id: z.string() }),
        response: constructResponseSchema(SelectMemoryItemSchema),
      },
    },
    async ({ params: { id }, user, organizationId }, reply) => {
      const [teamIds, member] = await Promise.all([
        TeamModel.getUserTeamIds(user.id),
        MemberModel.getByUserId(user.id, organizationId),
      ]);

      const unarchived = await memoryReviewService.unarchive({
        itemId: id,
        organizationId,
        reviewer: { id: user.id, role: member?.role },
        teamIds,
      });

      if (!unarchived) {
        throw new ApiError(
          409,
          "Cannot unarchive this memory item — it may not be archived or you lack access",
        );
      }

      return reply.send(unarchived);
    },
  );

  fastify.delete(
    "/api/memory/:id",
    {
      schema: {
        operationId: RouteId.DeleteMemory,
        description: "Hard-delete a memory item",
        tags: ["Memory"],
        params: z.object({ id: z.string() }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { id }, user, organizationId }, reply) => {
      const [teamIds, member] = await Promise.all([
        TeamModel.getUserTeamIds(user.id),
        MemberModel.getByUserId(user.id, organizationId),
      ]);

      const deleted = await memoryReviewService.hardDelete({
        itemId: id,
        organizationId,
        reviewer: { id: user.id, role: member?.role },
        teamIds,
      });

      if (!deleted) {
        throw new ApiError(
          404,
          "Memory item not found or not authorized to delete",
        );
      }

      return reply.send({ success: true });
    },
  );
};

export default memoryRoutes;

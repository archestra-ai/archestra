import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasAnyAgentTypeAdminPermission } from "@/auth";
import { AppaApprovalModel } from "@/models";
import {
  ApiError,
  AppaApprovalReviewSchema,
  constructResponseSchema,
} from "@/types";

const ListApprovalsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const appaApprovalRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/appa-approvals",
    {
      schema: {
        operationId: RouteId.ListAppaApprovals,
        tags: ["OpenAPPA"],
        querystring: ListApprovalsQuerySchema,
        response: constructResponseSchema(z.array(AppaApprovalReviewSchema)),
      },
    },
    async ({ organizationId, user, query }) => {
      const isAgentAdmin = await hasAnyAgentTypeAdminPermission({
        userId: user.id,
        organizationId,
      });
      return AppaApprovalModel.list({
        organizationId,
        userId: user.id,
        isAgentAdmin,
        limit: query.limit,
      });
    },
  );

  fastify.get(
    "/api/appa-approvals/:id",
    {
      schema: {
        operationId: RouteId.GetAppaApproval,
        tags: ["OpenAPPA"],
        params: z.object({ id: z.string().uuid() }),
        response: constructResponseSchema(AppaApprovalReviewSchema),
      },
    },
    async ({ organizationId, user, params }) => {
      const isAgentAdmin = await hasAnyAgentTypeAdminPermission({
        userId: user.id,
        organizationId,
      });
      const approval = await AppaApprovalModel.get({
        organizationId,
        userId: user.id,
        isAgentAdmin,
        id: params.id,
      });
      if (!approval) throw new ApiError(404, "Approval not found");
      return approval;
    },
  );

  fastify.post(
    "/api/appa-approvals/:id/decision",
    {
      schema: {
        operationId: RouteId.DecideAppaApproval,
        tags: ["OpenAPPA"],
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ decision: z.enum(["approve", "deny"]) }).strict(),
        response: constructResponseSchema(AppaApprovalReviewSchema),
      },
    },
    async (request) => {
      if (request.authMethod !== "session") {
        throw new ApiError(
          403,
          "Human approval decisions require an interactive user session",
        );
      }
      const { organizationId, user, params, body } = request;
      const isAgentAdmin = await hasAnyAgentTypeAdminPermission({
        userId: user.id,
        organizationId,
      });
      const approval = await AppaApprovalModel.decide({
        organizationId,
        id: params.id,
        userId: user.id,
        isAgentAdmin,
        approverId: user.id,
        decision: body.decision,
        audit: {
          actorName: user.name ?? null,
          actorEmail: user.email,
          actorType: "user",
          impersonatedBy: request.impersonatedBy ?? null,
          requestId: request.id,
          httpPath: request.url.split("?")[0] ?? request.url,
        },
      });
      if (!approval) throw new ApiError(409, "Approval is no longer pending");
      // Success was audited atomically with the decision; failures use middleware.
      request.auditSkip = true;
      return approval;
    },
  );
};

export default appaApprovalRoutes;

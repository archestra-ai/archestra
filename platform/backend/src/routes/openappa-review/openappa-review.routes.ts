import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import logger from "@/logging";
import OpenAppaReviewContinuationModel from "@/models/openappa-review-continuation";
import {
  authorizeChatOpsReviewResume,
  readChatOpsReview,
  reviewActorStillAllowed,
} from "@/openappa/chatops-review";
import { reviewContinuationWorker } from "@/openappa/review-continuation";
import { ApiError, constructResponseSchema } from "@/types";
import { ErrorResponsesSchema } from "@/types/api";

const ReviewParamsSchema = z.object({
  taskId: z.uuid(),
});

const ReviewQuerySchema = z.object({
  approvalId: z.string().min(1),
});

const ReviewViewSchema = z.object({
  taskId: z.string(),
  approvalId: z.string(),
  offerId: z.string(),
  text: z.string(),
  tool: z.string().optional(),
  arguments: z.string().optional(),
});

const SubmitReviewBodySchema = z.object({
  approvalId: z.string().min(1),
  ruling: z.enum(["approve", "deny"]),
});

const SubmitReviewResponseSchema = z.object({
  status: z.literal("submitted"),
});

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/api/openappa-reviews/:taskId",
    {
      schema: {
        operationId: RouteId.GetOpenappaReview,
        tags: ["OpenAPPA"],
        params: ReviewParamsSchema,
        querystring: ReviewQuerySchema,
        response: constructResponseSchema(ReviewViewSchema),
      },
    },
    async (request) => {
      const result = await readChatOpsReview({
        taskId: request.params.taskId,
        approvalId: request.query.approvalId,
        reviewerUserId: request.user.id,
        organizationId: request.organizationId,
      });
      if (result.kind === "blocked") throw reviewError(result.reason);
      return result.view;
    },
  );

  app.post(
    "/api/openappa-reviews/:taskId",
    {
      schema: {
        operationId: RouteId.SubmitOpenappaReview,
        tags: ["OpenAPPA"],
        params: ReviewParamsSchema,
        body: SubmitReviewBodySchema,
        response: { ...ErrorResponsesSchema, 202: SubmitReviewResponseSchema },
      },
    },
    async (request, reply) => {
      const existing = await OpenAppaReviewContinuationModel.find(
        request.params.taskId,
        request.body.approvalId,
      );
      if (existing) {
        if (
          existing.organizationId !== request.organizationId ||
          existing.actorUserId !== request.user.id ||
          !(await reviewActorStillAllowed({
            organizationId: request.organizationId,
            reviewerUserId: request.user.id,
            agentId: existing.agentId,
          }))
        ) {
          throw new ApiError(403, "You cannot decide this review");
        }
        if (existing.approved !== (request.body.ruling === "approve"))
          throw new ApiError(
            409,
            "This review was already submitted with another ruling",
          );
        reply.code(202);
        return { status: "submitted" as const };
      }
      const gate = await authorizeChatOpsReviewResume({
        taskId: request.params.taskId,
        approvalId: request.body.approvalId,
        reviewerUserId: request.user.id,
        organizationId: request.organizationId,
      });
      if (gate.kind !== "allowed") {
        throw reviewError(
          gate.kind === "blocked" ? gate.reason : "not_openappa",
        );
      }
      if (!gate.origin) {
        throw new ApiError(
          409,
          "The original review destination could not be verified",
        );
      }
      const queued = await OpenAppaReviewContinuationModel.enqueue({
        organizationId: request.organizationId,
        actorUserId: request.user.id,
        taskId: request.params.taskId,
        approvalId: request.body.approvalId,
        approved: request.body.ruling === "approve",
        agentId: gate.agentId,
        sessionId: gate.sessionId,
        origin: gate.origin,
      });
      if (
        queued.actorUserId !== request.user.id ||
        queued.organizationId !== request.organizationId
      )
        throw new ApiError(403, "You cannot decide this review");
      if (queued.approved !== (request.body.ruling === "approve"))
        throw new ApiError(
          409,
          "This review was already submitted with another ruling",
        );
      void reviewContinuationWorker
        .tick()
        .catch((error) =>
          logger.error(
            { errorName: error instanceof Error ? error.name : "unknown" },
            "Review continuation dispatch failed",
          ),
        );
      reply.code(202);
      return { status: "submitted" as const };
    },
  );
};

function reviewError(reason: string): ApiError {
  if (
    reason === "wrong_actor" ||
    reason === "missing_reviewer" ||
    reason === "wrong_org" ||
    reason === "permission_revoked"
  ) {
    return new ApiError(403, "You cannot decide this review");
  }
  if (reason === "already_resolved") {
    return new ApiError(409, "This review was already decided");
  }
  if (reason === "expired") {
    return new ApiError(404, "This review has expired");
  }
  return new ApiError(404, "Review not found");
}

export default routes;

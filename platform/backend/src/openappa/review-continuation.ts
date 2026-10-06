import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { buildApprovalDecisionSendMessageRequest } from "@/agents/a2a/a2a-helper";
import { A2AManager } from "@/agents/a2a/a2a-manager";
import {
  A2AProtocolRole,
  type A2AProtocolSendMessageResponse,
  A2AProtocolTaskState,
} from "@/agents/a2a/a2a-protocol";
import logger from "@/logging";
import {
  A2ATaskApprovalRequestModel,
  A2ATaskModel,
  AgentRunModel,
} from "@/models";
import OpenAppaNativeRoomModel from "@/models/openappa-native-room";
import OpenAppaReviewContinuationModel from "@/models/openappa-review-continuation";
import { RouteCategory } from "@/observability/tracing";
import { ApiError } from "@/types";
import type { ReviewContinuation } from "@/types/openappa-review-continuation";
import {
  authorizeChatOpsReviewResume,
  reviewActorStillAllowed,
} from "./chatops-review";
import { deliverReviewContinuation } from "./review-delivery";

class ReviewContinuationWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error) =>
        logger.error(
          { errorName: error instanceof Error ? error.name : "unknown" },
          "Review continuation worker failed",
        ),
      );
    }, 2000);
    this.timer.unref();
    void this.tick().catch((error) =>
      logger.error(
        { errorName: error instanceof Error ? error.name : "unknown" },
        "Review continuation recovery failed",
      ),
    );
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  async tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.process().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async process(): Promise<void> {
    await Promise.all(
      (await OpenAppaReviewContinuationModel.work()).map(async (queued) => {
        try {
          await this.advance(queued);
        } catch (error) {
          logger.error(
            {
              errorName: error instanceof Error ? error.name : "unknown",
              continuationId: queued.id,
            },
            "Review continuation could not advance",
          );
        }
      }),
    );
  }

  private async advance(saved: ReviewContinuation): Promise<void> {
    let row = saved;
    const permission = {
      organizationId: row.organizationId,
      reviewerUserId: row.actorUserId,
      agentId: row.agentId,
    };
    if (!(await reviewActorStillAllowed(permission))) {
      await OpenAppaReviewContinuationModel.transition({
        ...row,
        next: "failed",
        failureReason: "permission_revoked",
      });
      return;
    }
    const manager = new A2AManager();
    const actor = {
      kind: "user" as const,
      id: row.actorUserId,
      organizationId: row.organizationId,
    };
    if (row.state === "delivering") {
      if (row.deliveryEventId === "phase:authorizing") {
        // Send is fenced by beforeSend persisting an event/phase marker first.
        // This owner never reached that fence; retry authorization, not inference.
        await OpenAppaReviewContinuationModel.transition({
          ...row,
          next: "ready",
          nextClaimId: null,
          deliveryEventId: null,
        });
        return;
      }
      // A crash after calling the provider is not permission to repeat its effect.
      const receipt = row.deliveryEventId
        ? await OpenAppaNativeRoomModel.findDelivery({
            organizationId: row.organizationId,
            sessionId: row.sessionId,
            eventId: row.deliveryEventId,
          })
        : null;
      await OpenAppaReviewContinuationModel.transition({
        ...row,
        next: receipt?.status === "delivered" ? "delivered" : "failed",
        ...(receipt?.status === "delivered"
          ? { result: null }
          : { failureReason: "delivery_outcome_unknown" }),
      });
      return;
    }
    if (row.state === "resuming") {
      const approval = await A2ATaskApprovalRequestModel.findByApprovalId(
        row.approvalId,
      );
      const task = await A2ATaskModel.findById(row.taskId);
      if (
        approval &&
        !approval.resolved &&
        task?.state === "TASK_STATE_INPUT_REQUIRED"
      ) {
        await OpenAppaReviewContinuationModel.transition({
          ...row,
          next: "queued",
          nextClaimId: null,
        });
        return;
      }
      if (approval?.resolved && approval.approved !== row.approved) {
        await OpenAppaReviewContinuationModel.transition({
          ...row,
          next: "failed",
          failureReason: "ruling_conflict",
        });
        return;
      }
      if (!task) return;
      if (
        task.state === "TASK_STATE_WORKING" ||
        task.state === "TASK_STATE_SUBMITTED"
      ) {
        const runtime = await AgentRunModel.findByTaskId(row.taskId);
        if (runtime && !runtime.endedAt) return;
        await OpenAppaReviewContinuationModel.transition({
          ...row,
          next: "ready",
          result: {
            message: {
              messageId: randomUUID(),
              role: A2AProtocolRole.Agent,
              parts: [
                {
                  text: "This reviewed execution has no confirmed result. It will not be replayed automatically; inspect the task before starting new work.",
                },
              ],
            },
          },
        });
        return;
      }
      const taskResult = await manager.getTask({
        actor,
        agentId: row.agentId,
        request: { id: row.taskId },
      });
      const ready = await OpenAppaReviewContinuationModel.transition({
        ...row,
        next: "ready",
        result: { task: taskResult },
      });
      if (!ready) return;
      row = ready;
    }
    if (row.state === "queued") {
      const claimed = await OpenAppaReviewContinuationModel.transition({
        ...row,
        next: "resuming",
        nextClaimId: randomUUID(),
      });
      if (!claimed) return;
      row = claimed;
      const gate = await authorizeChatOpsReviewResume({
        taskId: row.taskId,
        approvalId: row.approvalId,
        reviewerUserId: row.actorUserId,
        organizationId: row.organizationId,
      });
      if (gate.kind === "blocked" && gate.reason === "already_resolved") return;
      if (
        gate.kind !== "allowed" ||
        !gate.origin ||
        gate.agentId !== row.agentId ||
        gate.sessionId !== row.sessionId ||
        !isDeepStrictEqual(gate.origin, row.origin)
      ) {
        await OpenAppaReviewContinuationModel.transition({
          ...row,
          next: "failed",
          failureReason:
            gate.kind === "blocked" ? gate.reason : "origin_unavailable",
        });
        return;
      }
      const heartbeat = setInterval(() => {
        void OpenAppaReviewContinuationModel.transition({
          ...row,
          next: "resuming",
        }).catch((error) =>
          logger.error(
            {
              errorName: error instanceof Error ? error.name : "unknown",
              continuationId: row.id,
            },
            "Review heartbeat failed",
          ),
        );
      }, 5000);
      heartbeat.unref();
      let result: A2AProtocolSendMessageResponse;
      try {
        result = await manager.sendMessage({
          actor,
          agentId: row.agentId,
          request: buildApprovalDecisionSendMessageRequest({
            taskId: row.taskId,
            approvalDecisions: [
              { approvalId: row.approvalId, approved: row.approved },
            ],
          }),
          systemParams: {
            sessionId: row.sessionId,
            source:
              row.origin.type === "email"
                ? "email"
                : `chatops:${row.origin.provider}`,
            routeCategory:
              row.origin.type === "email"
                ? RouteCategory.EMAIL
                : RouteCategory.CHATOPS,
            reviewOrigin: row.origin,
          },
        });
      } finally {
        clearInterval(heartbeat);
      }
      // Partial parallel reviews can remain INPUT_REQUIRED without another execution.
      if (
        (result.task && result.task.id !== row.taskId) ||
        (result.message?.taskId && result.message.taskId !== row.taskId)
      ) {
        await OpenAppaReviewContinuationModel.transition({
          ...row,
          next: "failed",
          failureReason: "result_task_mismatch",
        });
        return;
      }
      if (result.task?.status.state === A2AProtocolTaskState.Working) return;
      const ready = await OpenAppaReviewContinuationModel.transition({
        ...row,
        next: "ready",
        result,
      });
      if (!ready) return;
      row = ready;
    }
    if (row.state === "ready" && row.result) {
      const result = row.result;
      const owner = await OpenAppaReviewContinuationModel.transition({
        ...row,
        next: "delivering",
        nextClaimId: randomUUID(),
        deliveryEventId: "phase:authorizing",
      });
      if (!owner) return;
      row = owner;
      const heartbeat = setInterval(() => {
        void OpenAppaReviewContinuationModel.transition({
          id: row.id,
          state: "delivering",
          claimId: row.claimId,
          next: "delivering",
        }).catch((error) =>
          logger.warn(
            { errorName: error instanceof Error ? error.name : "unknown" },
            "Review delivery heartbeat failed",
          ),
        );
      }, 5000);
      heartbeat.unref();
      try {
        await deliverReviewContinuation({
          origin: row.origin,
          session: {
            organizationId: row.organizationId,
            sessionId: row.sessionId,
            callerId: `user:${row.actorUserId}`,
          },
          agentId: row.agentId,
          reviewId: `${row.taskId}:${row.approvalId}`,
          result,
          beforeSend: async (eventId) => {
            if (!(await reviewActorStillAllowed(permission))) {
              await OpenAppaReviewContinuationModel.transition({
                ...row,
                next: "failed",
                failureReason: "permission_revoked",
              });
              throw new ApiError(
                403,
                "Review delivery permission was revoked",
                "native_delivery_denied",
              );
            }
            const sending = await OpenAppaReviewContinuationModel.transition({
              ...row,
              next: "delivering",
              deliveryEventId: eventId ?? "provider:untracked-sending",
            });
            if (!sending)
              throw new ApiError(
                409,
                "Review delivery ownership expired",
                "native_delivery_ambiguous",
              );
            row = sending;
          },
        });
        await OpenAppaReviewContinuationModel.transition({
          ...row,
          next: "delivered",
          result: null,
        });
      } catch (error) {
        const receipt =
          row.deliveryEventId &&
          !["phase:authorizing", "provider:untracked-sending"].includes(
            row.deliveryEventId,
          )
            ? await OpenAppaNativeRoomModel.findDelivery({
                organizationId: row.organizationId,
                sessionId: row.sessionId,
                eventId: row.deliveryEventId,
              })
            : null;
        const retry =
          row.deliveryEventId === "phase:authorizing" &&
          !(
            error instanceof ApiError &&
            ["native_delivery_denied", "native_delivery_ambiguous"].includes(
              error.internalCode ?? "",
            )
          );
        await OpenAppaReviewContinuationModel.transition({
          ...row,
          next:
            receipt?.status === "delivered"
              ? "delivered"
              : retry
                ? "ready"
                : "failed",
          ...(receipt?.status === "delivered"
            ? {}
            : retry
              ? { nextClaimId: null, deliveryEventId: null }
              : {
                  failureReason:
                    error instanceof ApiError &&
                    error.internalCode === "native_delivery_denied"
                      ? "native_delivery_denied"
                      : "delivery_outcome_unknown",
                }),
        });
      } finally {
        clearInterval(heartbeat);
      }
    }
  }
}
export const reviewContinuationWorker = new ReviewContinuationWorker();

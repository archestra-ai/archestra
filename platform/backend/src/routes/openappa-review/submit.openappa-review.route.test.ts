import crypto from "node:crypto";
import { TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME } from "@archestra/shared";
import type { UIMessage } from "ai";
import { eq } from "drizzle-orm";
import { onTestFinished, vi } from "vitest";
import { A2AProtocolRole } from "@/agents/a2a/a2a-protocol";
import * as executor from "@/agents/a2a-executor";
import * as incomingEmail from "@/agents/incoming-email";
import { OutlookEmailProvider } from "@/agents/incoming-email/outlook-provider";
import config from "@/config";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import A2ATaskModel from "@/models/a2a/task";
import A2ATaskApprovalRequestModel from "@/models/a2a/task-approval-request";
import AuditLogModel from "@/models/audit-log";
import GuardrailsDeploymentModel from "@/models/guardrails-deployment";
import MemberModel from "@/models/member";
import OpenAppaNativeRoomModel from "@/models/openappa-native-room";
import OpenAppaReviewContinuationModel from "@/models/openappa-review-continuation";
import {
  applyResumedChatOpsReviews,
  parkDurableReviewPauses,
  persistForegroundEmailReview,
} from "@/openappa/chatops-review";
import { consumeHitlRuling, stageHitlReview } from "@/openappa/hitl-review";
import { contentDigest } from "@/openappa/native-contract";
import { signOfferClaims, unsignedOfferClaims } from "@/openappa/offer-claims";
import { reviewContinuationWorker } from "@/openappa/review-continuation";
import { emailReviewOrigin } from "@/openappa/review-origin";
import * as service from "@/openappa/service";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { useRouteTestApp } from "@/test/route-test-app";
import { ApiError } from "@/types";
import routes from "./openappa-review.routes";

setupTestCacheManager();

describe("POST /api/openappa-reviews/:taskId", () => {
  const ctx = useRouteTestApp(async (app) => {
    registerAuditLogHook(app);
    await app.register(routes);
  });
  const original = { ...config.openappa };
  beforeEach(() => {
    config.openappa = {
      ...original,
      enabled: true,
      offerSigningSecret: "review-route-test-signing-secret-32chars",
    };
  });
  afterEach(async () => {
    await reviewContinuationWorker.stop();
    config.openappa = original;
    vi.restoreAllMocks();
  });

  for (const ruling of ["approve", "deny"] as const) {
    test(`records ${ruling} once, resumes the original session and delivers its result`, async ({
      makeAgent,
      makeMember,
    }) => {
      await makeMember(ctx.user.id, ctx.organizationId);
      const agent = await makeAgent({
        organizationId: ctx.organizationId,
        agentType: "agent",
        authorId: ctx.user.id,
      });
      const seeded = await seed({
        agentId: agent.id,
        userId: ctx.user.id,
        organizationId: ctx.organizationId,
      });
      const provider = new OutlookEmailProvider({
        clientId: "client",
        clientSecret: "secret",
        tenantId: "tenant",
        mailboxAddress: "agents@example.com",
      });
      vi.spyOn(incomingEmail, "getEmailProvider").mockReturnValue(provider);
      const sent = vi
        .spyOn(provider, "sendReply")
        .mockResolvedValue("reply-id");
      const retired = vi
        .spyOn(service, "executeRemedyByOffer")
        .mockResolvedValue({ known: true, result: { content: [] } });
      const execute = vi
        .spyOn(executor, "executeA2AMessage")
        .mockImplementation(async (params) => {
          expect(params.source).toBe("email");
          const originalUser = params.originalUiMessages?.find(
            (entry) => entry.role === "user",
          );
          expect(originalUser?.parts).toEqual(
            expect.arrayContaining([
              { type: "text", text: "Complete the approved request" },
              expect.objectContaining({ type: "file", filename: "input.txt" }),
            ]),
          );
          expect(params.sessionId).toBe(seeded.session.session_id);
          const resumed = await applyResumedChatOpsReviews({
            messages: params.originalUiMessages ?? [],
            reviewerUserId: params.userId,
            organizationId: params.organizationId,
          });
          expect(resumed.blockedApprovalIds).toEqual([]);
          expect(
            await consumeHitlRuling({
              session: seeded.session,
              offerId: seeded.offerId,
            }),
          ).toBe(ruling === "approve" ? "approve" : undefined);
          expect(
            await A2ATaskApprovalRequestModel.findByApprovalId(
              seeded.approvalId,
            ),
          ).toBeNull();
          await inference;
          finishedInference = true;
          const responseUiMessage: UIMessage = {
            id: crypto.randomUUID(),
            role: "assistant",
            parts: [{ type: "text", text: "Resumed result" }],
          };
          return {
            messageId: responseUiMessage.id,
            text: "Resumed result",
            finishReason: "stop",
            responseUiMessage,
          };
        });
      let releaseInference = () => {};
      const inference = new Promise<void>((resolve) => {
        releaseInference = resolve;
      });
      let finishedInference = false;
      const releaseIfBroken = setTimeout(() => releaseInference(), 5000);
      onTestFinished(() => {
        clearTimeout(releaseIfBroken);
        releaseInference();
      });
      const audit = vi.spyOn(AuditLogModel, "create");

      const response = await ctx.app.inject({
        method: "POST",
        url: `/api/openappa-reviews/${seeded.taskId}`,
        payload: { approvalId: seeded.approvalId, ruling },
      });
      expect(response.statusCode, response.body).toBe(202);
      expect(finishedInference).toBe(false);
      expect(
        await OpenAppaReviewContinuationModel.find(
          seeded.taskId,
          seeded.approvalId,
        ),
      ).not.toBeNull();
      releaseInference();
      clearTimeout(releaseIfBroken);
      await reviewContinuationWorker.tick();
      expect(execute).toHaveBeenCalledOnce();
      expect(sent).toHaveBeenCalledWith(
        expect.objectContaining({
          originalEmail: expect.objectContaining({
            messageId: "original-email",
            toAddress: "agents@example.com",
          }),
          body: "Resumed result",
        }),
      );
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "openappaReview.updated",
          outcome: "success",
          after: expect.objectContaining({
            submissions: [
              expect.objectContaining({
                approved: ruling === "approve",
                state: expect.any(String),
              }),
            ],
          }),
        }),
      );
      if (ruling === "deny")
        expect(retired).toHaveBeenCalledWith(
          expect.objectContaining({ ruling: "deny" }),
        );
      else expect(retired).not.toHaveBeenCalled();

      const duplicate = await ctx.app.inject({
        method: "POST",
        url: `/api/openappa-reviews/${seeded.taskId}`,
        payload: { approvalId: seeded.approvalId, ruling: "approve" },
      });
      expect(duplicate.statusCode).toBe(ruling === "approve" ? 202 : 409);
      expect(execute).toHaveBeenCalledOnce();
      expect(sent).toHaveBeenCalledOnce();
    });
  }

  test("a persisted result survives an unavailable destination and delivers without re-running the approved turn", async ({
    makeAgent,
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId);
    const agent = await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
      authorId: ctx.user.id,
    });
    const seeded = await seed({
      agentId: agent.id,
      userId: ctx.user.id,
      organizationId: ctx.organizationId,
    });
    const row = await OpenAppaReviewContinuationModel.enqueue({
      organizationId: ctx.organizationId,
      actorUserId: ctx.user.id,
      taskId: seeded.taskId,
      approvalId: seeded.approvalId,
      approved: true,
      agentId: agent.id,
      sessionId: seeded.session.session_id,
      origin: emailReviewOrigin({
        messageId: "original-email",
        fromAddress: "alice@example.com",
        toAddress: "agents@example.com",
        conversationId: "original-thread",
        receivedAt: new Date(),
        subject: "",
        body: "",
      }),
    });
    await OpenAppaReviewContinuationModel.transition({
      ...row,
      next: "ready",
      result: {
        message: {
          messageId: crypto.randomUUID(),
          role: A2AProtocolRole.Agent,
          parts: [{ text: "Durable approved result" }],
        },
      },
    });
    vi.spyOn(incomingEmail, "getEmailProvider").mockReturnValue(null);
    const execute = vi.spyOn(executor, "executeA2AMessage");
    await reviewContinuationWorker.tick();
    expect(
      (
        await OpenAppaReviewContinuationModel.find(
          seeded.taskId,
          seeded.approvalId,
        )
      )?.state,
    ).toBe("ready");
    const provider = new OutlookEmailProvider({
      clientId: "client",
      clientSecret: "synthetic",
      tenantId: "tenant",
      mailboxAddress: "agents@example.com",
    });
    vi.mocked(incomingEmail.getEmailProvider).mockReturnValue(provider);
    const sent = vi.spyOn(provider, "sendReply").mockResolvedValue("reply-id");
    await reviewContinuationWorker.tick();
    await reviewContinuationWorker.tick();
    expect(sent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ body: "Durable approved result" }),
    );
    expect(execute).not.toHaveBeenCalled();
    expect(
      (
        await OpenAppaReviewContinuationModel.find(
          seeded.taskId,
          seeded.approvalId,
        )
      )?.state,
    ).toBe("delivered");
  });

  for (const scenario of [
    "replicas",
    "lookup",
    "denied",
    "pending",
    "pre-auth-crash",
  ] as const)
    test(`claim-first delivery ${scenario} never loses a result as a delivered notice`, async ({
      makeAgent,
      makeMember,
    }) => {
      await makeMember(ctx.user.id, ctx.organizationId);
      const agent = await makeAgent({
        organizationId: ctx.organizationId,
        agentType: "agent",
        authorId: ctx.user.id,
      });
      const seeded = await seed({
        agentId: agent.id,
        userId: ctx.user.id,
        organizationId: ctx.organizationId,
      });
      const task = await A2ATaskModel.findById(seeded.taskId);
      if (!task) throw new Error("Expected owned task");
      if (seeded.origin.type !== "email")
        throw new Error("Expected email origin");
      const body = "Saved private result";
      const queued = await OpenAppaReviewContinuationModel.enqueue({
        organizationId: ctx.organizationId,
        actorUserId: ctx.user.id,
        taskId: seeded.taskId,
        approvalId: seeded.approvalId,
        approved: true,
        agentId: agent.id,
        sessionId: seeded.session.session_id,
        origin: seeded.origin,
      });
      const ready = await OpenAppaReviewContinuationModel.transition({
        ...queued,
        next: "ready",
        result: {
          message: {
            messageId: crypto.randomUUID(),
            taskId: task.id,
            contextId: task.contextId,
            role: A2AProtocolRole.Agent,
            parts: [{ text: body }],
          },
        },
      });
      if (!ready) throw new Error("Expected durable result");
      const provider = new OutlookEmailProvider({
        clientId: "client",
        clientSecret: "secret",
        tenantId: "tenant",
        mailboxAddress: "agents@example.com",
      });
      vi.spyOn(incomingEmail, "getEmailProvider").mockReturnValue(provider);
      const recipients = vi
        .spyOn(provider, "getReplyRecipients")
        .mockResolvedValue([seeded.origin.fromAddress]);
      const sent = vi
        .spyOn(provider, "sendReply")
        .mockResolvedValue("provider-id");
      if (
        scenario === "lookup" ||
        scenario === "pending" ||
        scenario === "denied"
      ) {
        config.openappa.enabled = true;
        await GuardrailsDeploymentModel.setEnabled(true);
      }
      if (scenario === "lookup")
        recipients.mockRejectedValue(
          new Error("Transient recipient lookup outage"),
        );
      if (scenario === "denied")
        recipients.mockRejectedValue(
          new ApiError(403, "Current destination access denied"),
        );
      if (scenario === "pending") {
        const threadId =
          seeded.origin.conversationId ?? seeded.origin.messageId;
        const facts = {
          ref: {
            provider: "outlook" as const,
            workspaceId: seeded.origin.toAddress.toLowerCase(),
            channelId: threadId,
            threadId,
          },
          trust: "suspicious" as const,
          readers: {
            status: "resolved" as const,
            emails: [seeded.origin.fromAddress],
          },
        };
        const room = await OpenAppaNativeRoomModel.register({
          organizationId: ctx.organizationId,
          facts,
        });
        if (room.status !== "registered")
          throw new Error("Expected immutable snapshot");
        await OpenAppaNativeRoomModel.claimDelivery({
          organizationId: ctx.organizationId,
          sessionId: seeded.session.session_id,
          eventId: `outlook:${seeded.taskId}:${seeded.approvalId}:reply`,
          roomId: room.snapshot.roomId,
          contentDigest: contentDigest(body),
        });
      }
      if (scenario === "pre-auth-crash") {
        await OpenAppaReviewContinuationModel.transition({
          ...ready,
          next: "delivering",
          nextClaimId: crypto.randomUUID(),
          deliveryEventId: "phase:authorizing",
        });
        await db
          .update(schema.openappaReviewContinuationsTable)
          .set({ updatedAt: new Date(0) })
          .where(eq(schema.openappaReviewContinuationsTable.id, ready.id));
      }
      // Two actual worker instances model replicas without mocking CAS/database or exporting internals for tests.
      const replica = new (
        reviewContinuationWorker.constructor as new () => typeof reviewContinuationWorker
      )();
      await Promise.all([reviewContinuationWorker.tick(), replica.tick()]);
      const settled = await OpenAppaReviewContinuationModel.find(
        seeded.taskId,
        seeded.approvalId,
      );
      if (scenario === "replicas") {
        expect(sent).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ body }),
        );
        expect(settled?.state).toBe("delivered");
      } else {
        expect(sent).not.toHaveBeenCalled();
        expect(settled?.state).toBe(
          scenario === "pending" || scenario === "denied" ? "failed" : "ready",
        );
        if (scenario === "pending")
          expect(settled?.failureReason).toBe("delivery_outcome_unknown");
        else if (scenario === "denied") {
          expect(settled?.failureReason).toBe("native_delivery_denied");
          expect(settled?.result).toBeNull();
        } else expect(JSON.stringify(settled?.result)).toContain(body);
      }
      if (scenario === "pre-auth-crash") {
        await reviewContinuationWorker.tick();
        expect(sent).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ body }),
        );
        expect(
          (
            await OpenAppaReviewContinuationModel.find(
              seeded.taskId,
              seeded.approvalId,
            )
          )?.state,
        ).toBe("delivered");
      }
      await replica.stop();
    });

  test("parallel approvals of one task resume inference once and consume both exact rulings", async ({
    makeAgent,
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId);
    const agent = await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
      authorId: ctx.user.id,
    });
    const seeded = await seed({
      agentId: agent.id,
      userId: ctx.user.id,
      organizationId: ctx.organizationId,
      offerCount: 2,
    });
    const provider = new OutlookEmailProvider({
      clientId: "client",
      clientSecret: "secret",
      tenantId: "tenant",
      mailboxAddress: "agents@example.com",
    });
    vi.spyOn(incomingEmail, "getEmailProvider").mockReturnValue(provider);
    const sent = vi.spyOn(provider, "sendReply").mockResolvedValue("reply-id");
    const execute = vi
      .spyOn(executor, "executeA2AMessage")
      .mockImplementation(async (params) => {
        expect(
          (
            await applyResumedChatOpsReviews({
              messages: params.originalUiMessages ?? [],
              reviewerUserId: params.userId,
              organizationId: params.organizationId,
            })
          ).blockedApprovalIds,
        ).toEqual([]);
        for (const review of seeded.reviews)
          expect(
            await consumeHitlRuling({
              session: seeded.session,
              offerId: review.offerId,
            }),
          ).toBe("approve");
        const responseUiMessage: UIMessage = {
          id: crypto.randomUUID(),
          role: "assistant",
          parts: [{ type: "text", text: "Both approvals resumed once" }],
        };
        return {
          messageId: responseUiMessage.id,
          text: "Both approvals resumed once",
          finishReason: "stop",
          responseUiMessage,
        };
      });
    const responses = await Promise.all(
      seeded.links.map((link) =>
        ctx.app.inject({
          method: "POST",
          url: `/api/openappa-reviews/${link.taskId}`,
          payload: { approvalId: link.approvalId, ruling: "approve" },
        }),
      ),
    );
    expect(responses.map((response) => response.statusCode)).toEqual([
      202, 202,
    ]);
    await reviewContinuationWorker.tick();
    await reviewContinuationWorker.tick();
    expect(execute).toHaveBeenCalledOnce();
    for (const link of seeded.links) {
      expect(
        (
          await OpenAppaReviewContinuationModel.find(
            link.taskId,
            link.approvalId,
          )
        )?.state,
      ).toBe("delivered");
      expect(
        await A2ATaskApprovalRequestModel.findByApprovalId(link.approvalId),
      ).toBeNull();
    }
    expect(sent).toHaveBeenCalledWith(
      expect.objectContaining({ body: "Both approvals resumed once" }),
    );
  });

  for (const consumed of [false, true])
    test(`stale resuming recovery ${consumed ? "quarantines a possibly executed turn" : "requeues an unconsumed decision"}`, async ({
      makeAgent,
      makeMember,
    }) => {
      await makeMember(ctx.user.id, ctx.organizationId);
      const agent = await makeAgent({
        organizationId: ctx.organizationId,
        agentType: "agent",
        authorId: ctx.user.id,
      });
      const seeded = await seed({
        agentId: agent.id,
        userId: ctx.user.id,
        organizationId: ctx.organizationId,
      });
      const row = await OpenAppaReviewContinuationModel.enqueue({
        organizationId: ctx.organizationId,
        actorUserId: ctx.user.id,
        taskId: seeded.taskId,
        approvalId: seeded.approvalId,
        approved: true,
        agentId: agent.id,
        sessionId: seeded.session.session_id,
        origin: seeded.origin,
      });
      await OpenAppaReviewContinuationModel.transition({
        ...row,
        next: "resuming",
        nextClaimId: crypto.randomUUID(),
      });
      if (consumed) {
        await A2ATaskModel.updateState(seeded.taskId, "TASK_STATE_WORKING");
        await db
          .update(schema.a2aTaskApprovalRequestsTable)
          .set({ resolved: true, approved: true })
          .where(
            eq(
              schema.a2aTaskApprovalRequestsTable.approvalId,
              seeded.approvalId,
            ),
          );
      }
      await db
        .update(schema.openappaReviewContinuationsTable)
        .set({ updatedAt: new Date(0) })
        .where(eq(schema.openappaReviewContinuationsTable.id, row.id));
      const execute = vi.spyOn(executor, "executeA2AMessage");
      const provider = new OutlookEmailProvider({
        clientId: "client",
        clientSecret: "secret",
        tenantId: "tenant",
        mailboxAddress: "agents@example.com",
      });
      vi.spyOn(incomingEmail, "getEmailProvider").mockReturnValue(provider);
      const sent = vi
        .spyOn(provider, "sendReply")
        .mockResolvedValue("reply-id");
      await reviewContinuationWorker.tick();
      const recovered = await OpenAppaReviewContinuationModel.find(
        row.taskId,
        row.approvalId,
      );
      expect(recovered?.state).toBe(consumed ? "ready" : "queued");
      expect(execute).not.toHaveBeenCalled();
      expect(sent).not.toHaveBeenCalled();
      if (consumed) {
        await reviewContinuationWorker.tick();
        expect(sent).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            body: expect.stringContaining("will not be replayed automatically"),
          }),
        );
        expect(execute).not.toHaveBeenCalled();
        expect(
          (
            await OpenAppaReviewContinuationModel.find(
              row.taskId,
              row.approvalId,
            )
          )?.state,
        ).toBe("delivered");
      }
    });

  for (const outcome of ["delivered", "pending", "failed", "absent"] as const) {
    test(`restart recovery never replays an ambiguous send (${outcome} receipt)`, async ({
      makeAgent,
      makeMember,
    }) => {
      await makeMember(ctx.user.id, ctx.organizationId);
      const agent = await makeAgent({
        organizationId: ctx.organizationId,
        agentType: "agent",
        authorId: ctx.user.id,
      });
      const seeded = await seed({
        agentId: agent.id,
        userId: ctx.user.id,
        organizationId: ctx.organizationId,
      });
      const row = await OpenAppaReviewContinuationModel.enqueue({
        organizationId: ctx.organizationId,
        actorUserId: ctx.user.id,
        taskId: seeded.taskId,
        approvalId: seeded.approvalId,
        approved: true,
        agentId: agent.id,
        sessionId: seeded.session.session_id,
        origin: emailReviewOrigin({
          messageId: "original-email",
          fromAddress: "alice@example.com",
          toAddress: "agents@example.com",
          conversationId: "original-thread",
          receivedAt: new Date(),
          subject: "",
          body: "",
        }),
      });
      const eventId = `review:${seeded.approvalId}`;
      await OpenAppaReviewContinuationModel.transition({
        ...row,
        next: "delivering",
        nextClaimId: crypto.randomUUID(),
        deliveryEventId: eventId,
      });
      if (outcome !== "absent") {
        const receipt = {
          organizationId: row.organizationId,
          sessionId: row.sessionId,
          eventId,
          roomId: "verified-room",
          contentDigest: "confirmed-body",
        };
        await OpenAppaNativeRoomModel.claimDelivery(receipt);
        if (outcome !== "pending")
          await OpenAppaNativeRoomModel.recordDelivery({
            ...receipt,
            status: outcome,
          });
      }
      await db
        .update(schema.openappaReviewContinuationsTable)
        .set({ updatedAt: new Date(0) })
        .where(eq(schema.openappaReviewContinuationsTable.id, row.id));
      const execute = vi.spyOn(executor, "executeA2AMessage");
      const destination = vi.spyOn(incomingEmail, "getEmailProvider");
      await reviewContinuationWorker.tick();
      const recovered = await OpenAppaReviewContinuationModel.find(
        row.taskId,
        row.approvalId,
      );
      expect(recovered?.state).toBe(
        outcome === "delivered" ? "delivered" : "failed",
      );
      expect(recovered?.failureReason).toBe(
        outcome === "delivered" ? null : "delivery_outcome_unknown",
      );
      expect(execute).not.toHaveBeenCalled();
      expect(destination).not.toHaveBeenCalled();
    });
  }

  test("queued continuation cannot use the signing owner's stale membership", async ({
    makeAgent,
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId);
    const agent = await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
      authorId: ctx.user.id,
    });
    const seeded = await seed({
      agentId: agent.id,
      userId: ctx.user.id,
      organizationId: ctx.organizationId,
    });
    await OpenAppaReviewContinuationModel.enqueue({
      organizationId: ctx.organizationId,
      actorUserId: ctx.user.id,
      taskId: seeded.taskId,
      approvalId: seeded.approvalId,
      approved: true,
      agentId: agent.id,
      sessionId: seeded.session.session_id,
      origin: emailReviewOrigin({
        messageId: "original-email",
        fromAddress: "alice@example.com",
        toAddress: "agents@example.com",
        conversationId: "original-thread",
        receivedAt: new Date(),
        subject: "",
        body: "",
      }),
    });
    await MemberModel.deleteByMemberOrUserId(ctx.user.id, ctx.organizationId);
    const execute = vi.spyOn(executor, "executeA2AMessage");
    await reviewContinuationWorker.tick();
    expect(
      (
        await OpenAppaReviewContinuationModel.find(
          seeded.taskId,
          seeded.approvalId,
        )
      )?.state,
    ).toBe("failed");
    expect(execute).not.toHaveBeenCalled();
    expect(
      (await A2ATaskApprovalRequestModel.findByApprovalId(seeded.approvalId))
        ?.resolved,
    ).toBe(false);
  });

  test("another reviewer cannot resume or deliver the owner's task", async ({
    makeUser,
    makeAgent,
  }) => {
    const owner = await makeUser();
    const agent = await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
      authorId: owner.id,
    });
    const seeded = await seed({
      agentId: agent.id,
      userId: owner.id,
      organizationId: ctx.organizationId,
    });
    const execute = vi.spyOn(executor, "executeA2AMessage");
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/openappa-reviews/${seeded.taskId}`,
      payload: { approvalId: seeded.approvalId, ruling: "approve" },
    });
    expect(response.statusCode).toBe(403);
    expect(execute).not.toHaveBeenCalled();
    expect(
      await consumeHitlRuling({
        session: seeded.session,
        offerId: seeded.offerId,
      }),
    ).toBeUndefined();
  });

  for (const mode of ["missing", "tampered"] as const) {
    test(`unverified ${mode} routing remains blocked without resolving the review`, async ({
      makeAgent,
      makeMember,
    }) => {
      await makeMember(ctx.user.id, ctx.organizationId);
      const agent = await makeAgent({
        organizationId: ctx.organizationId,
        agentType: "agent",
        authorId: ctx.user.id,
      });
      const seeded = await seed({
        agentId: agent.id,
        userId: ctx.user.id,
        organizationId: ctx.organizationId,
        invalidOrigin: mode,
      });
      const execute = vi.spyOn(executor, "executeA2AMessage");
      const response = await ctx.app.inject({
        method: "POST",
        url: `/api/openappa-reviews/${seeded.taskId}`,
        payload: { approvalId: seeded.approvalId, ruling: "approve" },
      });
      expect(response.statusCode).toBe(409);
      expect(execute).not.toHaveBeenCalled();
      expect((await A2ATaskModel.findById(seeded.taskId))?.state).toBe(
        "TASK_STATE_INPUT_REQUIRED",
      );
      expect(
        await consumeHitlRuling({
          session: seeded.session,
          offerId: seeded.offerId,
        }),
      ).toBeUndefined();
    });
  }
});

async function seed(params: {
  agentId: string;
  userId: string;
  organizationId: string;
  invalidOrigin?: "missing" | "tampered";
  offerCount?: number;
}) {
  const session = {
    organization_id: params.organizationId,
    caller_id: `user:${params.userId}`,
    session_id: `email-${crypto.randomUUID()}`,
  };
  const reviews = Array.from({ length: params.offerCount ?? 1 }, (_, index) => {
    const offerId = crypto.randomUUID();
    const remedyArguments = { offer_id: offerId, plan: "real" };
    const jws = signOfferClaims(
      unsignedOfferClaims({
        organizationId: params.organizationId,
        callerId: session.caller_id,
        sessionId: session.session_id,
        offerId,
        tool: "send_message",
      }),
      config.openappa.offerSigningSecret,
    );
    return {
      offerId,
      remedyArguments,
      jws,
      toolCallId: `review-call-${index}`,
    };
  });
  const offerId = reviews[0].offerId;
  const uiMessage: UIMessage = {
    id: crypto.randomUUID(),
    role: "assistant",
    parts: reviews.map((review) => ({
      type: `tool-${TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME}`,
      toolCallId: review.toolCallId,
      state: "output-available",
      input: { ...review.remedyArguments, ...review.jws },
      output: {},
    })),
  };
  const origin = emailReviewOrigin({
    messageId: "original-email",
    fromAddress: "alice@example.com",
    toAddress: "agents@example.com",
    conversationId: "original-thread",
    receivedAt: new Date("2026-01-01T00:00:00Z"),
    subject: "",
    body: "",
  });
  const parked = parkDurableReviewPauses({
    message: uiMessage,
    pauses: reviews.map((review) => ({ ...review, session })),
    origin,
  });
  if (params.invalidOrigin === "missing") {
    parked.metadata = undefined;
  } else if (params.invalidOrigin === "tampered") {
    parked.metadata = JSON.parse(JSON.stringify(parked.metadata));
    const metadata = parked.metadata as {
      openappaReviewOrigins: Record<string, { origin: { toAddress: string } }>;
    };
    metadata.openappaReviewOrigins[offerId].origin.toAddress =
      "other@example.net";
  }
  for (const review of reviews)
    await stageHitlReview({
      session,
      review: {
        offerId: review.offerId,
        text: "Private review",
        tool: "send_message",
        arguments: "{}",
        remedyArguments: review.remedyArguments,
      },
    });
  vi.spyOn(service, "loadOfferReview").mockImplementation(async (request) =>
    reviews.some((review) => review.offerId === request.offerId)
      ? {
          offer_id: request.offerId,
          session_id: session.session_id,
          text: "Private review",
          tool: "send_message",
          arguments: "{}",
        }
      : null,
  );
  const links = await persistForegroundEmailReview({
    actor: {
      kind: "user",
      id: params.userId,
      organizationId: params.organizationId,
    },
    agentId: params.agentId,
    uiMessage: parked,
    originalTurn: {
      text: "Complete the approved request",
      attachments: [
        {
          contentType: "text/plain",
          name: "input.txt",
          contentBase64: "YWxsb3dlZCBpbnB1dA==",
        },
      ],
    },
  });
  const link = links[0];
  if (!link) throw new Error("Review was not persisted");
  return { ...link, session, offerId, links, reviews, origin };
}

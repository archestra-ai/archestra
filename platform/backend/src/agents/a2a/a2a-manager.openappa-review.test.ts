import { vi } from "vitest";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import {
  consumeHitlRuling,
  reviewSessionFromTrajectory,
} from "@/openappa/hitl-review";
import * as openappaService from "@/openappa/service";
import { expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import type { A2AActor } from "./a2a-base";
import { buildApprovalDecisionSendMessageRequest } from "./a2a-helper";
import { A2AManager } from "./a2a-manager";
import { A2AProtocolRole, A2AProtocolTaskState } from "./a2a-protocol";

const { executeA2AMessage } = vi.hoisted(() => ({
  executeA2AMessage: vi.fn(),
}));
vi.mock("@/agents/a2a-executor.ts", () => ({ executeA2AMessage }));

setupTestCacheManager();

const SESSION_ID = "a2a-session-1";
const REVIEW_TEXT = "Approve this call?\nsend_email to ceo@example.com";

function pausedOnRemedy(messageId: string) {
  return {
    responseUiMessage: {
      id: messageId,
      role: "assistant",
      parts: [
        {
          type: `tool-${archestraMcpBranding.getToolName("execute_remedy_plan")}`,
          state: "approval-requested",
          approval: { id: "approval-1" },
          toolCallId: "call-1",
          input: {
            offer_id: "offer-1",
            trajectory: { v: 1, session_id: SESSION_ID },
          },
        },
      ],
    },
  };
}

function finished(messageId: string) {
  return {
    messageId,
    text: "done",
    finishReason: "stop",
    responseUiMessage: {
      id: messageId,
      role: "assistant",
      parts: [{ type: "text", text: "done" }],
    },
  };
}

for (const approved of [true, false]) {
  test(`the A2A caller's ${approved ? "approval" : "decline"} reaches the paused remedy call as its ruling`, async ({
    makeAgent,
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });
    const actor: A2AActor = {
      id: user.id,
      kind: "user",
      organizationId: org.id,
    };
    vi.spyOn(openappaService, "loadOfferReview").mockResolvedValue({
      offer_id: "offer-1",
      text: REVIEW_TEXT,
      session_id: SESSION_ID,
    });
    const manager = new A2AManager({
      taskMode: "full",
      callerAnswersOpenappaReviews: true,
    });
    const messageId = crypto.randomUUID();
    executeA2AMessage.mockResolvedValueOnce(pausedOnRemedy(messageId));

    const paused = await manager.sendMessage({
      actor,
      agentId: agent.id,
      request: {
        message: {
          messageId: crypto.randomUUID(),
          role: A2AProtocolRole.User,
          parts: [{ text: "Email the CEO." }],
        },
      },
      taskRun: { createTask: true, detached: false },
    });

    expect(executeA2AMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ openappaReviewPause: true }),
    );
    if (!paused.task) throw new Error("expected a paused task");
    expect(paused.task.status.state).toBe(A2AProtocolTaskState.InputRequired);
    expect(paused.task.metadata?.approvalRequests).toEqual([
      expect.objectContaining({
        approvalId: "approval-1",
        openappaReview: expect.objectContaining({
          offerId: "offer-1",
          text: REVIEW_TEXT,
        }),
      }),
    ]);

    // The resumed run is where `execute_remedy_plan` spends the ruling.
    let rulingSeenByRun: string | undefined;
    executeA2AMessage.mockImplementationOnce(async () => {
      rulingSeenByRun = await consumeHitlRuling({
        session: reviewSessionFromTrajectory({
          organizationId: org.id,
          trajectory: { session_id: SESSION_ID },
          context: { userId: user.id },
        }),
        offerId: "offer-1",
      });
      return finished(messageId);
    });
    const resumed = await manager.sendMessage({
      actor,
      agentId: agent.id,
      request: buildApprovalDecisionSendMessageRequest({
        taskId: paused.task.id,
        approvalDecisions: [{ approvalId: "approval-1", approved }],
      }),
    });

    expect(rulingSeenByRun).toBe(approved ? "approve" : "deny");
    expect(resumed.task?.status.state).toBe(A2AProtocolTaskState.Completed);
  });
}

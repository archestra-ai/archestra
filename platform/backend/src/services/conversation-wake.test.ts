import { beforeEach, vi } from "vitest";
import {
  ConversationChatErrorModel,
  ConversationModel,
  MessageModel,
} from "@/models";
import ActiveChatRunModel from "@/models/chat-active-run";
import { activeChatRunService } from "@/services/active-chat-run";
import { conversationWakeService } from "@/services/conversation-wake";
import { afterEach, describe, expect, test } from "@/test";

vi.mock("@/agents/a2a-executor", () => ({
  executeA2AMessage: vi.fn(),
}));

import { executeA2AMessage } from "@/agents/a2a-executor";

const executeMock = vi.mocked(executeA2AMessage);

/**
 * The conversation wake service: persists a wake notification, then makes
 * sure a wake turn actually runs — the browser gets a grace window, and with
 * nobody watching the turn runs headlessly under the same one-run-per-
 * conversation mutex as the interactive path.
 */
describe("conversation wake service", () => {
  const originalTimings = { ...conversationWakeService.timings };
  beforeEach(() => {
    executeMock.mockReset();
    conversationWakeService.timings.idlePollMs = 10;
    conversationWakeService.timings.idleWaitDeadlineMs = 500;
    conversationWakeService.timings.headlessGraceMs = 40;
    conversationWakeService.timings.headlessGracePollMs = 10;
  });
  afterEach(() => {
    Object.assign(conversationWakeService.timings, originalTimings);
  });

  async function makeConversation(ctx: {
    makeUser: (overrides?: Record<string, unknown>) => Promise<{ id: string }>;
    makeOrganization: () => Promise<{ id: string }>;
    makeAgent: (overrides?: Record<string, unknown>) => Promise<{ id: string }>;
  }) {
    const user = await ctx.makeUser();
    const org = await ctx.makeOrganization();
    const agent = await ctx.makeAgent();
    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Wake test",
    });
    return { user, org, agent, conversation };
  }

  const wakeParams = (conversationId: string) => ({
    conversationId,
    messageId: `wake-test-${conversationId}`,
    text: "[Wake] something happened",
    metadata: { backgroundTask: { taskId: "t", status: "completed" } },
  });

  test("a browser-claimed turn during the grace window suppresses the headless fallback", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const { user, org, conversation } = await makeConversation({
      makeUser,
      makeOrganization,
      makeAgent,
    });

    // Simulate the browser claiming the wake turn: a running row appears
    // right after delivery starts (as the resubmitted POST /api/chat would).
    const deliverPromise = conversationWakeService.deliver(
      wakeParams(conversation.id),
    );
    const run = await activeChatRunService.createRun({
      conversationId: conversation.id,
      userId: user.id,
      organizationId: org.id,
    });
    expect(run).not.toBeNull();

    await deliverPromise;
    // The notification persisted, but no headless turn ran.
    expect(executeMock).not.toHaveBeenCalled();
    const messages = await MessageModel.findByConversation(conversation.id);
    expect(messages).toHaveLength(1);
    // biome-ignore lint/style/noNonNullAssertion: asserted non-null above
    await activeChatRunService.markTerminal({
      runId: run!.id,
      status: "completed",
    });
  });

  test("a failing headless turn persists a visible chat error and fails the run", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const { conversation } = await makeConversation({
      makeUser,
      makeOrganization,
      makeAgent,
    });
    executeMock.mockRejectedValue(new Error("provider exploded"));

    await conversationWakeService.deliver(wakeParams(conversation.id));

    // Notification persisted; the failure is visible, not silent.
    const messages = await MessageModel.findByConversation(conversation.id);
    expect(messages).toHaveLength(1);
    const errors = await ConversationChatErrorModel.findByConversation(
      conversation.id,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].error.message).toContain("provider exploded");
    // The mutex row is terminal, not stuck running.
    const running = await ActiveChatRunModel.findRunningByConversation(
      conversation.id,
    );
    expect(running).toBeNull();
  });

  test("a stop request aborts the headless turn as cancelled without an error card", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const { conversation } = await makeConversation({
      makeUser,
      makeOrganization,
      makeAgent,
    });

    executeMock.mockImplementation(
      (params) =>
        new Promise((_resolve, reject) => {
          params.abortSignal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
          // Once the headless run exists, ask it to stop — as the stop route
          // would from any replica.
          void (async () => {
            for (let i = 0; i < 100; i++) {
              const running =
                await ActiveChatRunModel.findRunningByConversation(
                  conversation.id,
                );
              if (running) {
                await activeChatRunService.requestStop({
                  conversationId: conversation.id,
                  organizationId: running.organizationId,
                });
                return;
              }
              await new Promise((r) => setTimeout(r, 10));
            }
          })();
        }),
    );

    await conversationWakeService.deliver(wakeParams(conversation.id));

    const running = await ActiveChatRunModel.findRunningByConversation(
      conversation.id,
    );
    expect(running).toBeNull();
    // A user-requested stop is not an error.
    const errors = await ConversationChatErrorModel.findByConversation(
      conversation.id,
    );
    expect(errors).toHaveLength(0);
  });
});

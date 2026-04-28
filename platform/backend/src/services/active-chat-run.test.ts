import type { UIMessageChunk } from "ai";
import ActiveChatRunModel from "@/models/chat-active-run";
import { activeChatRunService } from "@/services/active-chat-run";
import { expect, test } from "@/test";

test("drainStreamToEvents compacts adjacent text and reasoning deltas before marking terminal", async ({
  makeAgent,
  makeConversation,
  makeOrganization,
  makeUser,
}) => {
  const user = await makeUser();
  const organization = await makeOrganization();
  const agent = await makeAgent({ organizationId: organization.id });
  const conversation = await makeConversation(agent.id, {
    userId: user.id,
    organizationId: organization.id,
  });
  const run = await ActiveChatRunModel.create({
    conversationId: conversation.id,
    userId: user.id,
    organizationId: organization.id,
  });

  activeChatRunService.drainStreamToEvents({
    runId: run?.id ?? "",
    conversationId: conversation.id,
    stream: createChunkStream([
      { type: "start" },
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", delta: "hel" },
      { type: "text-delta", id: "text-1", delta: "lo" },
      { type: "reasoning-start", id: "reasoning-1" },
      { type: "reasoning-delta", id: "reasoning-1", delta: "a" },
      { type: "reasoning-delta", id: "reasoning-1", delta: "b" },
      { type: "text-delta", id: "text-2", delta: "separate" },
      { type: "finish", finishReason: "stop" },
    ]),
    getTerminalStatus: async () => ({ status: "completed" }),
  });

  await waitForTerminalRun(run?.id ?? "");
  const events = await ActiveChatRunModel.readEventsAfter({
    runId: run?.id ?? "",
    seq: 0,
  });

  expect(events).toHaveLength(1);
  expect(events[0]?.payloads).toEqual([
    { type: "start" },
    { type: "text-start", id: "text-1" },
    { type: "text-delta", id: "text-1", delta: "hello" },
    { type: "reasoning-start", id: "reasoning-1" },
    { type: "reasoning-delta", id: "reasoning-1", delta: "ab" },
    { type: "text-delta", id: "text-2", delta: "separate" },
    { type: "finish", finishReason: "stop" },
  ]);

  const terminalRun = await ActiveChatRunModel.findById(run?.id ?? "");
  expect(terminalRun?.status).toBe("completed");
});

function createChunkStream(
  payloads: UIMessageChunk[],
): ReadableStream<UIMessageChunk> {
  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const payload of payloads) {
        controller.enqueue(payload);
      }
      controller.close();
    },
  });
}

async function waitForTerminalRun(runId: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const run = await ActiveChatRunModel.findById(runId);
    if (run && run.status !== "running") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("Active chat run did not reach terminal status");
}

import { expect, test } from "@/test";
import ChatToolExecutionClaimModel from "./chat-tool-execution-claim";

async function makeClaimableConversation(f: {
  makeUser: () => Promise<{ id: string }>;
  makeOrganization: () => Promise<{ id: string }>;
  makeAgent: (overrides: Record<string, unknown>) => Promise<{ id: string }>;
  makeConversation: (
    agentId: string,
    overrides: Record<string, unknown>,
  ) => Promise<{ id: string }>;
}) {
  const user = await f.makeUser();
  const org = await f.makeOrganization();
  const agent = await f.makeAgent({ organizationId: org.id });
  const conversation = await f.makeConversation(agent.id, {
    organizationId: org.id,
    userId: user.id,
  });
  return conversation.id;
}

test("claim: first caller wins, second gets the existing row", async ({
  makeUser,
  makeOrganization,
  makeAgent,
  makeConversation,
}) => {
  const conversationId = await makeClaimableConversation({
    makeUser,
    makeOrganization,
    makeAgent,
    makeConversation,
  });
  const key = { conversationId, toolCallId: "call-1", toolName: "srv__write" };

  const first = await ChatToolExecutionClaimModel.claim(key);
  expect(first.claimed).toBe(true);

  const second = await ChatToolExecutionClaimModel.claim(key);
  expect(second.claimed).toBe(false);
  if (!second.claimed) {
    expect(second.existing?.state).toBe("executing");
    expect(second.existing?.toolName).toBe("srv__write");
  }
});

test("recordOutcome transitions executing → terminal but never overwrites a terminal state", async ({
  makeUser,
  makeOrganization,
  makeAgent,
  makeConversation,
}) => {
  const conversationId = await makeClaimableConversation({
    makeUser,
    makeOrganization,
    makeAgent,
    makeConversation,
  });
  const key = { conversationId, toolCallId: "call-1" };
  await ChatToolExecutionClaimModel.claim({ ...key, toolName: "srv__write" });

  await ChatToolExecutionClaimModel.recordOutcome({
    ...key,
    state: "completed",
    result: { resultKind: "content", content: "done", truncated: false },
  });
  const completed = await ChatToolExecutionClaimModel.findByKey(key);
  expect(completed?.state).toBe("completed");
  expect(completed?.result?.content).toBe("done");

  await ChatToolExecutionClaimModel.recordOutcome({
    ...key,
    state: "failed",
    result: { resultKind: "text", content: "boom", truncated: false },
  });
  const after = await ChatToolExecutionClaimModel.findByKey(key);
  expect(after?.state).toBe("completed");
  expect(after?.result?.content).toBe("done");
});

test("toStoredResult preserves shape kind and caps oversized content", () => {
  expect(ChatToolExecutionClaimModel.toStoredResult("plain text")).toEqual({
    resultKind: "text",
    content: "plain text",
    truncated: false,
  });
  expect(
    ChatToolExecutionClaimModel.toStoredResult({ content: "object result" }),
  ).toEqual({
    resultKind: "content",
    content: "object result",
    truncated: false,
  });

  const oversized = "x".repeat(150_000);
  const stored = ChatToolExecutionClaimModel.toStoredResult({
    content: oversized,
  });
  expect(stored.truncated).toBe(true);
  expect(stored.content).toHaveLength(100_000);
});

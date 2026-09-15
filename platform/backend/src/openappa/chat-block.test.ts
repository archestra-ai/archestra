import config from "@/config";
import { beforeEach, expect, test } from "@/test";
import {
  decodeChatBlock,
  encodeChatBlock,
  isChatBlockResult,
} from "./chat-block";

const session = {
  organization_id: "org",
  caller_id: "user:alice",
  session_id: "chat",
};
beforeEach(() => {
  config.auth.secret = "test-signing-secret";
});

test("only the signed, session-bound attempted call can bypass execution-result processing", () => {
  const receipt = encodeChatBlock({
    session,
    requestId: "2edfbd9f-ab24-4b4f-a1c0-346bb5c385a9",
    feedback: "Blocked. Accept restriction using offer-1.",
    calls: [{ id: "blocked-call", name: "read_private", arguments: {} }],
  });
  const content = {
    isError: true,
    content: [{ type: "text", text: "Blocked" }],
    _meta: { appaBlockedReceipt: receipt },
  };
  for (const encoded of [
    content,
    JSON.stringify(content),
    [{ type: "text", text: JSON.stringify(content) }],
  ]) {
    expect(
      isChatBlockResult({
        content: encoded,
        session,
        toolCallId: "blocked-call",
      }),
    ).toBe(true);
    expect(
      isChatBlockResult({
        content: encoded,
        session,
        toolCallId: "executed-call",
      }),
    ).toBe(false);
  }
  for (const other of [
    { ...session, caller_id: "user:bob" },
    { ...session, session_id: "other-chat" },
    { ...session, organization_id: "other-org" },
  ])
    expect(decodeChatBlock(receipt, other)).toBeNull();

  const [payload, signature] = receipt
    .slice("[archestra-appa-block:".length, -1)
    .split(".");
  const forged = JSON.parse(Buffer.from(payload, "base64url").toString());
  forged.calls[0].id = "executed-call";
  const tampered = `[archestra-appa-block:${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${signature}]`;
  expect(decodeChatBlock(tampered, session)).toBeNull();
  expect(
    isChatBlockResult({
      content: { ...content, _meta: { appaBlockedReceipt: tampered } },
      session,
      toolCallId: "executed-call",
    }),
  ).toBe(false);
});

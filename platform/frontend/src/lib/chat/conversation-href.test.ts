import { expect, test } from "vitest";
import { conversationHref } from "./conversation-href";

test("policy configuration sessions reopen in chat", () => {
  expect(conversationHref({ id: "policy-1", origin: "openappa" })).toBe(
    "/chat/policy-1",
  );
});

test("ordinary and scheduled sessions retain their chat destinations", () => {
  expect(conversationHref({ id: "chat-1", origin: "user" })).toBe(
    "/chat/chat-1",
  );
  expect(
    conversationHref({
      id: "run-1",
      origin: "schedule_trigger",
      scheduledRun: { id: "task-1", triggerId: "trigger-1" },
    }),
  ).toBe("/chat/run-1?scheduleTriggerId=trigger-1&scheduleRunId=task-1");
});

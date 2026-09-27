// @vitest-environment node
import { expect, test } from "vitest";
import { conversationHref } from "./conversation-href";

test("sessions open in chat", () => {
  expect(conversationHref({ id: "chat-1" })).toBe("/chat/chat-1");
});

test("scheduled sessions carry their run context", () => {
  expect(
    conversationHref({
      id: "run-1",
      scheduledRun: { id: "task-1", triggerId: "trigger-1" },
    }),
  ).toBe("/chat/run-1?scheduleTriggerId=trigger-1&scheduleRunId=task-1");
});

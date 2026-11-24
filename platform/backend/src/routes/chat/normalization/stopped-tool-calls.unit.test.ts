import { settleStoppedToolCalls } from "@archestra/shared/tool-call-normalization";
import { convertToModelMessages, type UIMessage } from "ai";
import { describe, expect, test } from "vitest";
import { normalizeChatMessagesForPersistence } from "./normalize-chat-messages";

const user = {
  id: "user-1",
  role: "user" as const,
  parts: [{ type: "text", text: "wait 60 s" }],
};
const runningCall = {
  type: "tool-fixtures__wait_then_reply",
  toolCallId: "call-1",
  state: "input-available",
  input: { seconds: 60 },
};
const assistantWith = (parts: Record<string, unknown>[]) => ({
  id: "assistant-1",
  role: "assistant" as const,
  parts: parts as { type: string }[],
});

describe("settleStoppedToolCalls", () => {
  test("a stopped call keeps its place in the turn, as a call that was stopped", () => {
    const messages = [
      user,
      assistantWith([{ type: "step-start" }, runningCall]),
    ];

    const settled = settleStoppedToolCalls(messages);

    expect(settled[1].parts[1]).toMatchObject({
      toolCallId: "call-1",
      input: { seconds: 60 },
      state: "output-available",
      output: {
        content: expect.stringContaining("stopped before this call finished"),
        _meta: { archestraError: { type: "cancelled" } },
      },
    });
  });

  test("a stopped turn survives the reload it used to vanish on", () => {
    const messages = [
      user,
      assistantWith([{ type: "step-start" }, runningCall]),
    ];

    // Without a result the call is stripped as dangling, and the turn, with
    // nothing else in it, is dropped.
    expect(
      normalizeChatMessagesForPersistence(messages).map((m) => m.role),
    ).toEqual(["user"]);
    expect(
      normalizeChatMessagesForPersistence(settleStoppedToolCalls(messages)).map(
        (m) => m.role,
      ),
    ).toEqual(["user", "assistant"]);
  });

  test("the model's next turn sees the call and that it did not finish", async () => {
    const settled = settleStoppedToolCalls([
      user,
      assistantWith([{ type: "step-start" }, runningCall]),
    ]);

    // A call without a result would fail the provider's validation.
    const replayed = await convertToModelMessages(
      settled as unknown as UIMessage[],
    );
    expect(JSON.stringify(replayed)).toContain(
      "stopped before this call finished",
    );
    expect(replayed.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
  });

  test("a call still receiving its arguments is left alone: it never ran", () => {
    const streaming = { ...runningCall, state: "input-streaming" };
    const messages = [user, assistantWith([streaming])];

    expect(settleStoppedToolCalls(messages)).toBe(messages);
  });

  test("finished calls and earlier turns are not touched", () => {
    const finished = {
      ...runningCall,
      toolCallId: "call-0",
      state: "output-available",
      output: { content: "done" },
    };
    const earlier = assistantWith([runningCall]);
    const messages = [earlier, user, assistantWith([finished, runningCall])];

    const settled = settleStoppedToolCalls(messages);

    expect(settled[0]).toBe(earlier);
    expect(settled[2].parts[0]).toBe(finished);
    expect(settled[2].parts[1]).toMatchObject({ state: "output-available" });
  });

  test("a run stopped before the assistant wrote anything changes nothing", () => {
    const messages = [user];

    expect(settleStoppedToolCalls(messages)).toBe(messages);
  });
});

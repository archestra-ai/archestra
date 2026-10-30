import { describe, expect, it } from "vitest";
import type { Interaction } from "./common";
import RealtimeInteraction from "./realtime";

describe("RealtimeInteraction", () => {
  it("titles a turn by what the user typed or said, and shows the reply's transcript", () => {
    const typed = new RealtimeInteraction({
      type: "openai:realtime",
      model: "gpt-realtime",
      request: { model: "gpt-realtime", turn: 1, input_text: "Say hello." },
      response: {
        id: "resp_1",
        status: "completed",
        output_transcript: "Hello there!",
      },
    } as unknown as Interaction);
    expect(typed.getLastUserMessage()).toBe("Say hello.");
    expect(typed.mapToUiMessages()).toEqual([
      { role: "user", parts: [{ type: "text", text: "Say hello." }] },
      { role: "assistant", parts: [{ type: "text", text: "Hello there!" }] },
    ]);

    const spoken = new RealtimeInteraction({
      type: "openai:realtime",
      model: "gpt-realtime",
      request: {
        model: "gpt-realtime",
        turn: 2,
        input_transcript: "What time is it?",
      },
      response: { id: "resp_2", status: "completed" },
    } as unknown as Interaction);
    expect(spoken.getLastUserMessage()).toBe("What time is it?");
    expect(spoken.getLastAssistantResponse()).toBe(
      "Realtime response completed with no transcript.",
    );

    const silent = new RealtimeInteraction({
      type: "openai:realtime",
      model: "gpt-realtime",
      request: { model: "gpt-realtime", turn: 3 },
      response: { id: "resp_3", status: "completed" },
    } as unknown as Interaction);
    expect(silent.getLastUserMessage()).toBe("Realtime turn 3");
  });
});

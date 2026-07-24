import { describe, expect, it } from "vitest";
import type { Interaction } from "./common";
import OpenAiResponsesInteraction from "./openai-responses";

describe("OpenAiResponsesInteraction", () => {
  it("maps used tools back to requested function calls", () => {
    const interaction = new OpenAiResponsesInteraction({
      type: "openai:responses",
      model: "gpt-4o",
      request: {
        model: "gpt-4o",
        input: [
          {
            type: "function_call_output",
            call_id: "call_1",
            output: '{"ok":true}',
          },
        ],
      },
      response: {
        output: [
          {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: "read_file",
            arguments: "{}",
            status: "completed",
          },
        ],
      },
    } as unknown as Interaction);

    expect(interaction.getToolNamesUsed()).toEqual(["read_file"]);
  });

  // The AI SDK serializes Responses turns as "easy input" messages — bare
  // `{role, content}` with no `type` — which the proxy's request adapter
  // already understands. Requiring the tag here dropped every SDK-sent message,
  // so LLM Logs rendered "No message" with an empty conversation preview.
  it("reads easy-input messages that omit a top-level type", () => {
    const interaction = new OpenAiResponsesInteraction({
      type: "openai:responses",
      model: "gpt-5.6",
      request: {
        model: "gpt-5.6",
        input: [
          { role: "developer", content: "You are helpful." },
          {
            role: "user",
            content: [{ type: "input_text", text: "count the r's" }],
          },
        ],
      },
      response: { output: [] },
    } as unknown as Interaction);

    expect(interaction.getLastUserMessage()).toBe("count the r's");
    expect(interaction.mapToUiMessages()).toEqual([
      { role: "system", parts: [{ type: "text", text: "You are helpful." }] },
      { role: "user", parts: [{ type: "text", text: "count the r's" }] },
    ]);
  });

  it("still reads explicitly typed message items", () => {
    const interaction = new OpenAiResponsesInteraction({
      type: "openai:responses",
      model: "gpt-5.6",
      request: {
        model: "gpt-5.6",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "typed" }],
          },
        ],
      },
      response: { output: [] },
    } as unknown as Interaction);

    expect(interaction.getLastUserMessage()).toBe("typed");
  });

  it("does not treat non-message input items as messages", () => {
    const interaction = new OpenAiResponsesInteraction({
      type: "openai:responses",
      model: "gpt-5.6",
      request: {
        model: "gpt-5.6",
        input: [
          { type: "function_call_output", call_id: "call_1", output: "{}" },
          { type: "reasoning", id: "rs_1", summary: [] },
        ],
      },
      response: { output: [] },
    } as unknown as Interaction);

    expect(interaction.getLastUserMessage()).toBe("");
    expect(interaction.mapToUiMessages()).toEqual([]);
  });
});

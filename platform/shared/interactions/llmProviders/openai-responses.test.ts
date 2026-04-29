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
});

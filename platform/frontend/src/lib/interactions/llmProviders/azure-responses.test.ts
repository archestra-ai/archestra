import { describe, expect, it } from "vitest";
import AzureResponsesInteraction from "./azure-responses";
import type { Interaction } from "./common";

describe("AzureResponsesInteraction", () => {
  it("maps used tools back to requested function calls", () => {
    const interaction = new AzureResponsesInteraction({
      type: "azure:responses",
      model: "gpt-4.1",
      request: {
        model: "gpt-4.1",
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

  it("extracts output_text content from stored input messages", () => {
    const interaction = new AzureResponsesInteraction({
      type: "azure:responses",
      model: "gpt-4.1",
      request: {
        model: "gpt-4.1",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "output_text", text: "stored user text" }],
          },
        ],
      },
      response: {
        output: [],
      },
    } as unknown as Interaction);

    expect(interaction.getLastUserMessage()).toBe("stored user text");
    expect(interaction.mapToUiMessages()).toEqual([
      {
        role: "user",
        parts: [{ type: "text", text: "stored user text" }],
      },
    ]);
  });
});

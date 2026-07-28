import { describe, expect, it } from "vitest";
import BedrockConverseInteraction from "./bedrock";
import type { Interaction } from "./common";

describe("BedrockConverseInteraction.getLastToolCallId", () => {
  it("returns the last toolUseId when a user message has multiple toolResults", () => {
    const interaction = new BedrockConverseInteraction({
      type: "bedrock:converse",
      model: "anthropic.claude-sonnet-4-5-v1:0",
      request: {
        modelId: "anthropic.claude-sonnet-4-5-v1:0",
        messages: [
          {
            role: "user",
            content: [
              { toolResult: { toolUseId: "tooluse_first", content: "one" } },
              { toolResult: { toolUseId: "tooluse_second", content: "two" } },
            ],
          },
        ],
      },
      response: { output: { message: { role: "assistant", content: [] } } },
    } as unknown as Interaction);

    expect(interaction.getLastToolCallId()).toBe("tooluse_second");
  });

  it("returns null when the last user message has no toolResult blocks", () => {
    const interaction = new BedrockConverseInteraction({
      type: "bedrock:converse",
      model: "anthropic.claude-sonnet-4-5-v1:0",
      request: {
        modelId: "anthropic.claude-sonnet-4-5-v1:0",
        messages: [{ role: "user", content: [{ text: "hello" }] }],
      },
      response: { output: { message: { role: "assistant", content: [] } } },
    } as unknown as Interaction);

    expect(interaction.getLastToolCallId()).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { DynamicInteraction } from "./interaction.utils";
import type { Interaction } from "./llmProviders/common";

describe("DynamicInteraction with a failed-interaction error response", () => {
  // A failed upstream call is persisted with the provider `type` but an
  // `{ error }` response instead of a provider response.
  const errorInteraction = {
    id: "interaction-1",
    type: "anthropic:messages",
    model: "claude-3-5-sonnet-20241022",
    request: {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 64,
      messages: [{ role: "user", content: "Hello" }],
    },
    response: { error: "Upstream provider returned an error response" },
  } as unknown as Interaction;

  it("surfaces the error text as the last assistant response", () => {
    const interaction = new DynamicInteraction(errorInteraction);
    expect(interaction.getLastAssistantResponse()).toBe(
      "Upstream provider returned an error response",
    );
  });

  it("renders the error as an assistant message instead of throwing", () => {
    const interaction = new DynamicInteraction(errorInteraction);
    const messages = interaction.mapToUiMessages();
    const last = messages[messages.length - 1];
    expect(last.role).toBe("assistant");
    expect(last.parts).toContainEqual({
      type: "text",
      text: "Upstream provider returned an error response",
    });
  });

  it("reports no tools for a failed interaction without reading the response", () => {
    // openai mappers iterate `response.choices`, which throws on an `{ error }`
    // response — so this exercises the guard (anthropic would no-op regardless).
    const openAiErrorInteraction = {
      id: "interaction-2",
      type: "openai:chatCompletions",
      model: "gpt-4o-mini",
      request: {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Hello" }],
      },
      response: { error: "Upstream provider returned an error response" },
    } as unknown as Interaction;

    const interaction = new DynamicInteraction(openAiErrorInteraction);
    expect(interaction.getToolNamesUsed()).toEqual([]);
    expect(interaction.getToolNamesRequested()).toEqual([]);
    expect(interaction.getToolNamesRefused()).toEqual([]);
    expect(interaction.getToolRefusedCount()).toBe(0);
  });
});

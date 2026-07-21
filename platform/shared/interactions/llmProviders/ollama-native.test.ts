import { describe, expect, it } from "vitest";
import type { Interaction } from "./common";
import OllamaNativeChatInteraction from "./ollama-native";

/**
 * Fixtures use Ollama's REAL native wire shape: `tool_calls` carry no `id` and
 * tool results are correlated by `tool_name`. The `tool_call_id` variants only
 * occur when the caller is ollama-ai-provider-v2.
 */
function interaction(
  request: Record<string, unknown>,
  response: Record<string, unknown> = {
    model: "llama3.2",
    message: { role: "assistant", content: "done" },
    done: true,
  },
): Interaction {
  return { request, response, model: "llama3.2" } as unknown as Interaction;
}

describe("OllamaNativeChatInteraction", () => {
  describe("basic extraction", () => {
    it("reads the last user message and assistant response", () => {
      const utils = new OllamaNativeChatInteraction(
        interaction({
          model: "llama3.2",
          messages: [
            { role: "user", content: "first" },
            { role: "assistant", content: "reply" },
            { role: "user", content: "second" },
          ],
        }),
      );

      expect(utils.getLastUserMessage()).toBe("second");
      expect(utils.getLastAssistantResponse()).toBe("done");
    });

    it("joins array content into text", () => {
      const utils = new OllamaNativeChatInteraction(
        interaction({
          model: "llama3.2",
          messages: [{ role: "user", content: [{ text: "a" }, { text: "b" }] }],
        }),
      );

      expect(utils.getLastUserMessage()).toBe("ab");
    });

    it("detects a trailing tool message", () => {
      const utils = new OllamaNativeChatInteraction(
        interaction({
          model: "llama3.2",
          messages: [
            { role: "user", content: "go" },
            { role: "tool", tool_name: "search", content: "result" },
          ],
        }),
      );

      expect(utils.isLastMessageToolCall()).toBe(true);
      // Native results carry no id — null here is correct, not a failure.
      expect(utils.getLastToolCallId()).toBeNull();
    });

    it("collects tool names from both sides of the turn", () => {
      const utils = new OllamaNativeChatInteraction(
        interaction(
          {
            model: "llama3.2",
            messages: [
              {
                role: "assistant",
                tool_calls: [
                  { function: { name: "search", arguments: {} } },
                  { function: { name: "fetch", arguments: {} } },
                ],
              },
            ],
          },
          {
            model: "llama3.2",
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{ function: { name: "next_tool", arguments: {} } }],
            },
            done: true,
          },
        ),
      );

      expect(utils.getToolNamesUsed()).toEqual(["search", "fetch"]);
      expect(utils.getToolNamesRequested()).toEqual(["next_tool"]);
      // The native wire has no `refusal` field to read.
      expect(utils.getToolNamesRefused()).toEqual([]);
      expect(utils.getToolRefusedCount()).toBe(0);
    });
  });

  describe("mapToUiMessages — tool result correlation", () => {
    it("pairs each id-less tool call with its own result", () => {
      const utils = new OllamaNativeChatInteraction(
        interaction({
          model: "llama3.2",
          messages: [
            { role: "user", content: "look both up" },
            {
              role: "assistant",
              content: "",
              tool_calls: [
                { function: { name: "weather", arguments: {} } },
                { function: { name: "stocks", arguments: {} } },
              ],
            },
            { role: "tool", tool_name: "weather", content: "sunny" },
            { role: "tool", tool_name: "stocks", content: "up" },
          ],
        }),
      );

      const assistantTurn = utils
        .mapToUiMessages()
        .find((m) => m.role === "assistant");
      const results = (assistantTurn?.parts ?? []).filter(
        (p) => p.type === "dynamic-tool" && p.state === "output-available",
      );

      // Matching on `tool_call_id === toolCall.id` is undefined === undefined
      // on this wire, so the first result used to attach to every call — an
      // actively misleading log for anyone debugging a bad agent run.
      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject({
        toolName: "weather",
        output: "sunny",
      });
      expect(results[1]).toMatchObject({ toolName: "stocks", output: "up" });
    });

    it("falls back to arrival order when names do not match", () => {
      const utils = new OllamaNativeChatInteraction(
        interaction({
          model: "llama3.2",
          messages: [
            { role: "user", content: "go" },
            {
              role: "assistant",
              content: "",
              tool_calls: [
                { function: { name: "a", arguments: {} } },
                { function: { name: "b", arguments: {} } },
              ],
            },
            { role: "tool", content: "first" },
            { role: "tool", content: "second" },
          ],
        }),
      );

      const assistantTurn = utils
        .mapToUiMessages()
        .find((m) => m.role === "assistant");
      const outputs = (assistantTurn?.parts ?? [])
        .filter(
          (p) => p.type === "dynamic-tool" && p.state === "output-available",
        )
        .map((p) => (p as { output: unknown }).output);

      expect(outputs).toEqual(["first", "second"]);
    });

    it("still correlates by id when the caller supplies one", () => {
      const utils = new OllamaNativeChatInteraction(
        interaction({
          model: "llama3.2",
          messages: [
            { role: "user", content: "go" },
            {
              role: "assistant",
              content: "",
              tool_calls: [
                { id: "call_1", function: { name: "a", arguments: {} } },
                { id: "call_2", function: { name: "b", arguments: {} } },
              ],
            },
            { role: "tool", tool_call_id: "call_2", content: "second" },
            { role: "tool", tool_call_id: "call_1", content: "first" },
          ],
        }),
      );

      const assistantTurn = utils
        .mapToUiMessages()
        .find((m) => m.role === "assistant");
      const outputs = (assistantTurn?.parts ?? [])
        .filter(
          (p) => p.type === "dynamic-tool" && p.state === "output-available",
        )
        .map((p) => (p as { output: unknown }).output);

      // Ids win over arrival order, so an out-of-order result still lands on
      // the right call.
      expect(outputs).toEqual(["first", "second"]);
    });

    it("names an id-less result from tool_name rather than 'tool-result'", () => {
      const utils = new OllamaNativeChatInteraction(
        interaction({
          model: "llama3.2",
          messages: [
            { role: "user", content: "go" },
            {
              role: "assistant",
              content: "",
              tool_calls: [{ function: { name: "search", arguments: {} } }],
            },
            { role: "tool", tool_name: "search", content: "hit" },
          ],
        }),
      );

      const assistantTurn = utils
        .mapToUiMessages()
        .find((m) => m.role === "assistant");
      const result = (assistantTurn?.parts ?? []).find(
        (p) => p.type === "dynamic-tool" && p.state === "output-available",
      );

      expect(result).toMatchObject({ toolName: "search" });
    });

    it("does not attach a dual-LLM analysis to an id-less call", () => {
      const utils = new OllamaNativeChatInteraction(
        interaction({
          model: "llama3.2",
          messages: [
            { role: "user", content: "go" },
            {
              role: "assistant",
              content: "",
              tool_calls: [{ function: { name: "search", arguments: {} } }],
            },
            { role: "tool", tool_name: "search", content: "hit" },
          ],
        }),
      );

      // The analysis is keyed by tool-call id; with none present, matching on
      // `undefined === undefined` would attach the first analysis to every call.
      const uiMessages = utils.mapToUiMessages([
        {
          toolCallId: "some-other-call",
          result: "safe",
          conversations: [],
        } as never,
      ]);
      const assistantTurn = uiMessages.find((m) => m.role === "assistant");

      const partTypes = (assistantTurn?.parts ?? []).map((p) => String(p.type));
      expect(partTypes).not.toContain("dual-llm-analysis");
    });
  });
});

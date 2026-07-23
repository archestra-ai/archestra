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

describe("OllamaNativeChatInteraction — result correlation and resilience", () => {
  it("never hands the same result to two calls of the same tool", () => {
    // The whole reason the `claimed` set exists. Both existing correlation
    // tests use distinct tool names, so deleting that set left them green.
    const uiMessages = new OllamaNativeChatInteraction(
      interaction({
        messages: [
          { role: "user", content: "search twice" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              { function: { name: "search", arguments: {} } },
              { function: { name: "search", arguments: {} } },
            ],
          },
          { role: "tool", tool_name: "search", content: "first" },
          { role: "tool", tool_name: "search", content: "second" },
        ],
      }),
    ).mapToUiMessages();

    const outputs = uiMessages
      .flatMap((m) => m.parts ?? [])
      .filter((p) => String(p.type) === "dynamic-tool")
      .filter((p) => "output" in p)
      .map((p) => (p as { output: unknown }).output);

    expect(outputs).toEqual(["first", "second"]);
  });

  it("does not let a later turn's result attach to an earlier call", () => {
    // An aborted turn leaves its own result missing; without bounding the
    // search at the next assistant message it claimed the next turn's by name.
    const uiMessages = new OllamaNativeChatInteraction(
      interaction({
        messages: [
          { role: "user", content: "go" },
          {
            role: "assistant",
            content: "",
            tool_calls: [{ function: { name: "search", arguments: {} } }],
          },
          {
            role: "assistant",
            content: "",
            tool_calls: [{ function: { name: "search", arguments: {} } }],
          },
          { role: "tool", tool_name: "search", content: "TURN2-RESULT" },
        ],
      }),
    ).mapToUiMessages();

    const assistantTurns = uiMessages.filter((m) => m.role === "assistant");
    const firstTurnOutputs = (assistantTurns[0]?.parts ?? []).filter(
      (p) => String(p.type) === "dynamic-tool" && "output" in p,
    );
    expect(firstTurnOutputs).toHaveLength(0);
  });

  it("survives a stored error response instead of dropping the request", () => {
    // A failed turn persists an `{ error }` sentinel. Throwing here made the
    // caller fall back to an empty list, hiding what was actually sent.
    const uiMessages = new OllamaNativeChatInteraction({
      request: {
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "partial" },
        ],
      },
      response: { error: "upstream 503" },
      model: "llama3.2",
    } as unknown as Interaction).mapToUiMessages();

    expect(uiMessages.some((m) => m.role === "user")).toBe(true);
  });

  it("gives every id-less tool part a distinct id", () => {
    // The native wire carries no ids. Falling back to "" gave every part the
    // same React key, because `?? ` does not catch the empty string.
    const uiMessages = new OllamaNativeChatInteraction(
      interaction({
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
          { role: "tool", tool_name: "a", content: "ra" },
          { role: "tool", tool_name: "b", content: "rb" },
        ],
      }),
    ).mapToUiMessages();

    const ids = uiMessages
      .flatMap((m) => m.parts ?? [])
      .filter((p) => String(p.type) === "dynamic-tool")
      .map((p) => (p as { toolCallId: string }).toolCallId);

    expect(ids.length).toBeGreaterThan(1);
    expect(ids).not.toContain("");
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("preserves unparseable tool arguments rather than showing none", () => {
    const uiMessages = new OllamaNativeChatInteraction(
      interaction({
        messages: [
          { role: "user", content: "go" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              { function: { name: "a", arguments: '{"path":"/etc/pas' } },
            ],
          },
        ],
      }),
    ).mapToUiMessages();

    const input = uiMessages
      .flatMap((m) => m.parts ?? [])
      .filter((p) => String(p.type) === "dynamic-tool")
      .map((p) => (p as { input: Record<string, unknown> }).input)
      .find((i) => i && "__archestra_unparsed_arguments" in i);

    expect(input?.__archestra_unparsed_arguments).toBe('{"path":"/etc/pas');
  });
});

import { convertToModelMessages, type UIMessage } from "ai";
import { describe, expect, test } from "vitest";
import {
  normalizeChatMessages,
  normalizeChatMessagesForPersistence,
} from "./normalize-chat-messages";

describe("normalizeChatMessages", () => {
  test("dedupes duplicate tool parts with the same toolCallId", () => {
    const messages = [
      {
        id: "msg1",
        role: "assistant" as const,
        parts: [
          { type: "text", text: "Creating the agent now." },
          {
            type: "tool-archestra__create_agent",
            toolCallId: "call_create_1",
            state: "output-available",
            output: "created",
          },
          {
            type: "tool-archestra__create_agent",
            toolCallId: "call_create_1",
            state: "output-available",
            output: "created",
          },
          {
            type: "tool-archestra__swap_agent",
            toolCallId: "call_swap_1",
            state: "output-available",
            output: "swapped",
          },
          {
            type: "tool-archestra__swap_agent",
            toolCallId: "call_swap_1",
            state: "output-available",
            output: "swapped",
          },
        ],
      },
    ];

    const result = normalizeChatMessages(messages);
    const dedupedParts = result[0].parts ?? [];

    expect(dedupedParts).toHaveLength(3);
    expect(
      dedupedParts.filter((part) => part.toolCallId === "call_create_1"),
    ).toHaveLength(1);
    expect(
      dedupedParts.filter((part) => part.toolCallId === "call_swap_1"),
    ).toHaveLength(1);
  });

  test("drops a dangling input-streaming tool call (stopped mid-stream)", () => {
    const messages = [
      {
        id: "msg1",
        role: "assistant" as const,
        parts: [
          { type: "text", text: "Looking that up." },
          {
            type: "tool-archestra__create_agent",
            toolCallId: "call_interrupted",
            state: "input-streaming",
            input: { name: "Ag" },
          },
        ],
      },
    ];

    const result = normalizeChatMessages(messages);

    expect(result[0].parts).toEqual([
      { type: "text", text: "Looking that up." },
    ]);
  });

  test("preserves distinct tool parts when toolCallIds differ", () => {
    const messages = [
      {
        id: "msg1",
        role: "assistant" as const,
        parts: [
          {
            type: "tool-archestra__create_agent",
            toolCallId: "call_create_1",
            state: "output-available",
            output: "created-1",
          },
          {
            type: "tool-archestra__create_agent",
            toolCallId: "call_create_2",
            state: "output-available",
            output: "created-2",
          },
        ],
      },
    ];

    const result = normalizeChatMessages(messages);

    expect(result[0].parts).toHaveLength(2);
  });
});

describe("normalizeChatMessages empty-assistant dropping", () => {
  test("drops an assistant turn left empty after a dangling tool call is stripped", () => {
    // a stopped/interrupted turn whose only part is an unresolved tool call
    const messages = [
      {
        id: "user1",
        role: "user" as const,
        parts: [{ type: "text", text: "go" }],
      },
      {
        id: "assistant1",
        role: "assistant" as const,
        parts: [
          {
            type: "tool-archestra__create_agent",
            toolCallId: "call_interrupted",
            state: "input-available",
            input: {},
          },
        ],
      },
    ];

    const result = normalizeChatMessages(messages);

    expect(result.map((m) => m.id)).toEqual(["user1"]);
  });

  test("keeps assistant turns that still render text or a completed tool result", () => {
    const messages = [
      {
        id: "with-text",
        role: "assistant" as const,
        parts: [{ type: "text", text: "done" }],
      },
      {
        id: "with-result",
        role: "assistant" as const,
        parts: [
          {
            type: "tool-archestra__create_agent",
            toolCallId: "call_ok",
            state: "output-available",
            output: "created",
          },
        ],
      },
    ];

    const result = normalizeChatMessages(messages);

    expect(result.map((m) => m.id)).toEqual(["with-text", "with-result"]);
  });

  test("drops an assistant turn left with only a step-start after a dangling tool call is stripped", () => {
    // AI SDK assistant messages open with step-start; an aborted turn that
    // emitted only a tool call leaves [step-start] once the call is stripped.
    const messages = [
      {
        id: "assistant1",
        role: "assistant" as const,
        parts: [
          { type: "step-start" },
          { type: "data-token-usage", data: { totalTokens: 10 } },
          {
            type: "tool-archestra__create_agent",
            toolCallId: "call_interrupted",
            state: "input-available",
            input: {},
          },
        ],
      },
    ];

    expect(normalizeChatMessages(messages)).toEqual([]);
  });

  test("keeps an MCP-app turn whose tool call completed", () => {
    const messages = [
      {
        id: "assistant1",
        role: "assistant" as const,
        parts: [
          { type: "step-start" },
          {
            type: "data-tool-ui-start",
            data: { toolCallId: "call_ok", toolName: "render_chart" },
          },
          {
            type: "tool-render_chart",
            toolCallId: "call_ok",
            state: "output-available",
            output: "rendered",
          },
        ],
      },
    ];

    expect(normalizeChatMessages(messages).map((m) => m.id)).toEqual([
      "assistant1",
    ]);
  });

  test("keeps an MCP-app turn whose tool call completed as a dynamic-tool", () => {
    // MCP tools deserialize to `dynamic-tool`, not `tool-<name>`; the marker must
    // still count as live so it survives persistence and renders as an MCP app.
    const messages = [
      {
        id: "assistant1",
        role: "assistant" as const,
        parts: [
          { type: "step-start" },
          {
            type: "data-tool-ui-start",
            data: { toolCallId: "call_ok", toolName: "render_chart" },
          },
          {
            type: "dynamic-tool",
            toolName: "render_chart",
            toolCallId: "call_ok",
            state: "output-available",
            output: "rendered",
          },
        ],
      },
    ];

    const result = normalizeChatMessages(messages);

    expect(result.map((m) => m.id)).toEqual(["assistant1"]);
    expect(result[0].parts?.map((p) => p.type)).toEqual([
      "step-start",
      "data-tool-ui-start",
      "dynamic-tool",
    ]);
  });

  test("drops a stopped MCP-app turn left with an orphaned tool-ui-start", () => {
    // abort after the MCP app started but before its tool call resolved:
    // stripDanglingToolCalls removes the input-streaming tool, leaving the
    // marker orphaned — the renderer would otherwise show a stuck running tool.
    const messages = [
      {
        id: "assistant1",
        role: "assistant" as const,
        parts: [
          { type: "step-start" },
          {
            type: "data-tool-ui-start",
            data: { toolCallId: "call_interrupted", toolName: "render_chart" },
          },
          {
            type: "tool-render_chart",
            toolCallId: "call_interrupted",
            state: "input-streaming",
            input: {},
          },
        ],
      },
    ];

    expect(normalizeChatMessages(messages)).toEqual([]);
  });

  test("leaves non-assistant messages untouched even when empty", () => {
    const messages = [
      { id: "u", role: "user" as const, parts: [] },
      { id: "s", role: "system" as const, parts: [] },
    ];

    expect(normalizeChatMessages(messages)).toEqual(messages);
  });
});

describe("normalizeChatMessagesForPersistence", () => {
  const keep = (id: string) => ({
    id,
    role: "user" as const,
    parts: [{ type: "text", text: "anchor" }],
  });

  test("drops an assistant turn with an empty parts array", () => {
    const messages = [
      keep("user1"),
      { id: "assistant1", role: "assistant" as const, parts: [] },
    ];

    expect(
      normalizeChatMessagesForPersistence(messages).map((m) => m.id),
    ).toEqual(["user1"]);
  });

  test("drops an assistant turn with missing parts", () => {
    const messages = [
      keep("user1"),
      { id: "assistant1", role: "assistant" as const },
    ];

    expect(
      normalizeChatMessagesForPersistence(messages).map((m) => m.id),
    ).toEqual(["user1"]);
  });

  test("drops an assistant turn with only empty/whitespace text", () => {
    const messages = [
      keep("user1"),
      {
        id: "assistant1",
        role: "assistant" as const,
        parts: [{ type: "text", text: "   " }],
      },
    ];

    expect(
      normalizeChatMessagesForPersistence(messages).map((m) => m.id),
    ).toEqual(["user1"]);
  });

  test("drops an assistant turn with only step-start/telemetry parts", () => {
    const messages = [
      keep("user1"),
      {
        id: "assistant1",
        role: "assistant" as const,
        parts: [
          { type: "step-start" },
          { type: "data-token-usage", data: { totalTokens: 10 } },
        ],
      },
    ];

    expect(
      normalizeChatMessagesForPersistence(messages).map((m) => m.id),
    ).toEqual(["user1"]);
  });

  test("drops an assistant turn left with an orphaned data-tool-ui-start", () => {
    // the marker's tool call never resolved — the looser normalize keeps the
    // turn for live view, but it must not be persisted as an empty bubble.
    const messages = [
      keep("user1"),
      {
        id: "assistant1",
        role: "assistant" as const,
        parts: [
          { type: "step-start" },
          {
            type: "data-tool-ui-start",
            data: { toolCallId: "call_interrupted", toolName: "render_chart" },
          },
          {
            type: "tool-render_chart",
            toolCallId: "call_interrupted",
            state: "input-streaming",
            input: {},
          },
        ],
      },
    ];

    expect(
      normalizeChatMessagesForPersistence(messages).map((m) => m.id),
    ).toEqual(["user1"]);
  });

  test("keeps an assistant turn with a completed tool result", () => {
    const messages = [
      keep("user1"),
      {
        id: "assistant1",
        role: "assistant" as const,
        parts: [
          {
            type: "tool-archestra__create_agent",
            toolCallId: "call_ok",
            state: "output-available",
            output: "created",
          },
        ],
      },
    ];

    expect(
      normalizeChatMessagesForPersistence(messages).map((m) => m.id),
    ).toEqual(["user1", "assistant1"]);
  });

  test("keeps an MCP-app marker only when paired with a completed tool part", () => {
    const paired = {
      id: "paired",
      role: "assistant" as const,
      parts: [
        { type: "step-start" },
        {
          type: "data-tool-ui-start",
          data: { toolCallId: "call_ok", toolName: "render_chart" },
        },
        {
          type: "tool-render_chart",
          toolCallId: "call_ok",
          state: "output-available",
          output: "rendered",
        },
      ],
    };
    // an MCP-app marker whose paired tool part never reached a terminal state
    // (here it is only input-available, which normalize strips as dangling).
    const unpaired = {
      id: "unpaired",
      role: "assistant" as const,
      parts: [
        { type: "step-start" },
        {
          type: "data-tool-ui-start",
          data: { toolCallId: "call_pending", toolName: "render_chart" },
        },
        {
          type: "tool-render_chart",
          toolCallId: "call_pending",
          state: "input-available",
          input: {},
        },
      ],
    };

    const result = normalizeChatMessagesForPersistence([
      keep("user1"),
      paired,
      unpaired,
    ]);

    expect(result.map((m) => m.id)).toEqual(["user1", "paired"]);
  });

  test("keeps an assistant turn whose only content is a generated image", () => {
    // model-generated images (e.g. Gemini) are preserved for multi-turn image
    // editing and must survive persistence.
    const messages = [
      keep("user1"),
      {
        id: "assistant1",
        role: "assistant" as const,
        parts: [
          { type: "step-start" },
          { type: "image", image: "data:image/png;base64,iVBOR..." },
        ],
      },
    ];

    expect(
      normalizeChatMessagesForPersistence(messages).map((m) => m.id),
    ).toEqual(["user1", "assistant1"]);
  });

  test("keeps an assistant turn that is still in approval-requested state", () => {
    // a paused tool approval renders a prompt the user must answer — it is real
    // content and must survive persistence (#4030).
    const messages = [
      keep("user1"),
      {
        id: "assistant1",
        role: "assistant" as const,
        parts: [
          {
            type: "tool-print_test",
            toolCallId: "call_wait",
            state: "approval-requested",
            input: {},
          },
        ],
      },
    ];

    expect(
      normalizeChatMessagesForPersistence(messages).map((m) => m.id),
    ).toEqual(["user1", "assistant1"]);
  });
});

describe("normalizeChatMessages malformed tool input", () => {
  test("repairs a poisoned output-error tool part, preserving the rest of the turn", () => {
    const messages = [
      {
        id: "user1",
        role: "user" as const,
        parts: [{ type: "text", text: "go" }],
      },
      {
        id: "assistant1",
        role: "assistant" as const,
        parts: [
          { type: "text", text: "editing" },
          {
            type: "tool-archestra__edit_app",
            toolCallId: "call_1",
            state: "output-error",
            errorText: "JSON parsing failed",
            input: undefined,
          },
        ],
      },
    ];

    const result = normalizeChatMessages(messages);
    const toolPart = result[1].parts?.find((p) => p.toolCallId === "call_1");

    expect(toolPart?.input).toEqual({});
    expect(toolPart?.state).toBe("output-error");
    expect(toolPart?.errorText).toBe("JSON parsing failed");
    expect(result[1].parts?.[0]).toEqual({ type: "text", text: "editing" });
  });

  // The real failing path: assert the actual AI SDK converter never emits a
  // non-object tool_use input for a previously-poisoned conversation.
  test("convertToModelMessages emits an object input for every tool_use", async () => {
    const messages = [
      {
        id: "user1",
        role: "user" as const,
        parts: [{ type: "text", text: "go" }],
      },
      {
        id: "assistant1",
        role: "assistant" as const,
        parts: [
          { type: "text", text: "editing" },
          {
            type: "tool-archestra__edit_app",
            toolCallId: "call_1",
            state: "output-error",
            errorText: "JSON parsing failed",
            input: '{"old_str">x',
          },
        ],
      },
    ];

    const normalized = normalizeChatMessages(messages);
    const modelMessages = await convertToModelMessages(
      normalized as unknown as UIMessage[],
    );

    const toolCalls = modelMessages
      .filter((m) => m.role === "assistant")
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((part) => part.type === "tool-call");

    expect(toolCalls.length).toBeGreaterThan(0);
    for (const call of toolCalls) {
      expect(call.input).toBeTypeOf("object");
      expect(call.input).not.toBeNull();
      expect(Array.isArray(call.input)).toBe(false);
    }
  });

  // A static (`tool-<name>`) tool keeps its unparsed args in `rawInput` with
  // `input` left undefined; convertToModelMessages reads `input ?? rawInput`, so
  // without coercion the malformed string would still reach the provider. This is
  // the shape the production brick actually took (no Input block in the export).
  test("convertToModelMessages emits an object input when malformed args are in rawInput", async () => {
    const messages = [
      {
        id: "user1",
        role: "user" as const,
        parts: [{ type: "text", text: "go" }],
      },
      {
        id: "assistant1",
        role: "assistant" as const,
        parts: [
          { type: "text", text: "editing" },
          {
            type: "tool-archestra__edit_app",
            toolCallId: "call_1",
            state: "output-error",
            errorText: "JSON parsing failed",
            rawInput: '{"old_str">x',
          },
        ],
      },
    ];

    const normalized = normalizeChatMessages(messages);
    const modelMessages = await convertToModelMessages(
      normalized as unknown as UIMessage[],
    );

    const toolCalls = modelMessages
      .filter((m) => m.role === "assistant")
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((part) => part.type === "tool-call");

    expect(toolCalls.length).toBeGreaterThan(0);
    for (const call of toolCalls) {
      expect(call.input).toBeTypeOf("object");
      expect(call.input).not.toBeNull();
      expect(Array.isArray(call.input)).toBe(false);
    }
  });

  // Pre-existing dedupe behavior (unchanged here): it keeps the FIRST part on a
  // signature that ignores `input`, so a malformed-first / valid-second pair
  // already drops the valid twin before coercion runs. We only assert the safety
  // invariant — the surviving input is a provider-valid object — not that losing
  // the twin's args is desirable. Recovering them would mean changing dedupe,
  // which is out of scope.
  test("duplicate tool parts: the surviving input is coerced to an object", () => {
    const messages = [
      {
        id: "assistant1",
        role: "assistant" as const,
        parts: [
          {
            type: "tool-x",
            toolCallId: "call_1",
            state: "output-available",
            output: "ok",
            input: "garbage",
          },
          {
            type: "tool-x",
            toolCallId: "call_1",
            state: "output-available",
            output: "ok",
            input: { valid: true },
          },
        ],
      },
    ];

    const result = normalizeChatMessages(messages);
    const toolParts = result[0].parts ?? [];

    expect(toolParts).toHaveLength(1);
    const input = toolParts[0].input;
    expect(typeof input).toBe("object");
    expect(input).not.toBeNull();
    expect(Array.isArray(input)).toBe(false);
  });

  test("leaves a clean conversation unchanged", () => {
    const messages = [
      {
        id: "user1",
        role: "user" as const,
        parts: [{ type: "text", text: "go" }],
      },
      {
        id: "assistant1",
        role: "assistant" as const,
        parts: [
          {
            type: "tool-x",
            toolCallId: "call_1",
            state: "output-available",
            output: "ok",
            input: { appId: "x" },
          },
        ],
      },
    ];

    expect(normalizeChatMessages(messages)).toEqual(messages);
  });
});

import { SUBAGENT_TOOL_CALL_PART_TYPE } from "@archestra/shared";
import { convertToModelMessages, type UIMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import type { ChatMessage, ChatMessagePart } from "@/types";
import {
  applySubagentToolCallsToMessages,
  createSubagentToolStreamBridge,
} from "./subagent-tool-stream";

function subagentPart(
  parentToolCallId: string,
  toolCallId: string,
  toolName = "web_search",
): ChatMessagePart {
  return {
    type: SUBAGENT_TOOL_CALL_PART_TYPE,
    data: { parentToolCallId, toolCallId, toolName, state: "output-available" },
  };
}

describe("createSubagentToolStreamBridge", () => {
  it("collects an emitted call and streams it with the toolCallId as chunk id", () => {
    const writes: unknown[] = [];
    const bridge = createSubagentToolStreamBridge();
    bridge.setWriter({ write: (chunk) => writes.push(chunk) });

    bridge.emit({
      parentToolCallId: "P1",
      toolCallId: "C1",
      toolName: "web_search",
      input: { q: "hi" },
      state: "output-available",
      output: { results: [] },
    });

    const collected = bridge.collected();
    expect(collected).toHaveLength(1);
    expect(collected[0]).toMatchObject({
      type: SUBAGENT_TOOL_CALL_PART_TYPE,
      data: {
        parentToolCallId: "P1",
        toolCallId: "C1",
        toolName: "web_search",
        input: { q: "hi" },
        output: { results: [] },
      },
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      type: SUBAGENT_TOOL_CALL_PART_TYPE,
      id: "C1",
      data: { parentToolCallId: "P1", toolCallId: "C1" },
    });
  });

  it("collects without a writer attached (headless) and never throws", () => {
    const bridge = createSubagentToolStreamBridge();
    expect(() =>
      bridge.emit({
        parentToolCallId: "P1",
        toolCallId: "C1",
        toolName: "x",
      }),
    ).not.toThrow();
    expect(bridge.collected()).toHaveLength(1);
  });

  it("caps an oversized output so the persisted part stays bounded", () => {
    const bridge = createSubagentToolStreamBridge();
    const huge = "x".repeat(50_000);
    bridge.emit({
      parentToolCallId: "P1",
      toolCallId: "C1",
      toolName: "screenshot",
      output: { image: huge },
    });

    const output = bridge.collected()[0]?.data as { output: unknown };
    expect(typeof output.output).toBe("string");
    expect((output.output as string).length).toBeLessThan(huge.length);
    expect(output.output as string).toContain("truncated");
  });

  it("leaves a small output as structured JSON (not stringified)", () => {
    const bridge = createSubagentToolStreamBridge();
    bridge.emit({
      parentToolCallId: "P1",
      toolCallId: "C1",
      toolName: "calc",
      output: { value: 42 },
    });
    const data = bridge.collected()[0]?.data as { output: unknown };
    expect(data.output).toEqual({ value: 42 });
  });
});

describe("applySubagentToolCallsToMessages", () => {
  const messages = (): ChatMessage[] => [
    { role: "user", parts: [{ type: "text", text: "go" }] },
    {
      role: "assistant",
      parts: [
        {
          type: "tool-agent__child",
          toolCallId: "P1",
          state: "output-available",
        },
        { type: "text", text: "done" },
      ],
    },
  ];

  it("returns the input unchanged when there are no parts to apply", () => {
    const input = messages();
    expect(applySubagentToolCallsToMessages(input, [])).toBe(input);
  });

  it("appends a direct child to the assistant message holding its delegation call", () => {
    const result = applySubagentToolCallsToMessages(messages(), [
      subagentPart("P1", "C1"),
    ]);
    const assistant = result[1];
    const appended = assistant.parts?.filter(
      (p) => p.type === SUBAGENT_TOOL_CALL_PART_TYPE,
    );
    expect(appended).toHaveLength(1);
    expect((appended?.[0]?.data as { toolCallId: string }).toolCallId).toBe(
      "C1",
    );
  });

  it("routes a deeper descendant (parent not a real tool part) to the last assistant message", () => {
    // C2 is a nested delegation call surfaced as a subagent part (not a real
    // tool part), so its child G1 falls back to the last assistant message.
    const result = applySubagentToolCallsToMessages(messages(), [
      subagentPart("P1", "C2", "agent__grandchild"),
      subagentPart("C2", "G1", "fetch"),
    ]);
    const appended = result[1].parts?.filter(
      (p) => p.type === SUBAGENT_TOOL_CALL_PART_TYPE,
    );
    expect(appended).toHaveLength(2);
    expect(
      appended?.map((p) => (p.data as { toolCallId: string }).toolCallId),
    ).toEqual(["C2", "G1"]);
  });

  it("does not mutate the input messages", () => {
    const input = messages();
    const before = input[1].parts?.length;
    applySubagentToolCallsToMessages(input, [subagentPart("P1", "C1")]);
    expect(input[1].parts?.length).toBe(before);
  });
});

describe("model-context exclusion (the hard constraint)", () => {
  it("convertToModelMessages drops data-subagent-tool-call parts entirely", async () => {
    const message: UIMessage = {
      id: "m1",
      role: "assistant",
      parts: [
        { type: "text", text: "Here is the summary." },
        {
          type: SUBAGENT_TOOL_CALL_PART_TYPE,
          // a data-* part carries no top-level toolCallId/toolName, so tool-part
          // pairing/normalization never touches it either.
          data: {
            parentToolCallId: "P1",
            toolCallId: "C1",
            toolName: "secret_internal_tool",
            input: { apiKey: "leak-me" },
            output: { rows: 99 },
            state: "output-available",
          },
        },
      ] as UIMessage["parts"],
    };

    const modelMessages = await convertToModelMessages([message]);
    const serialized = JSON.stringify(modelMessages);

    // The child's tool call must never reach the parent model's history.
    expect(serialized).not.toContain("secret_internal_tool");
    expect(serialized).not.toContain("leak-me");
    expect(serialized).not.toContain(SUBAGENT_TOOL_CALL_PART_TYPE);
    // The real assistant text still survives.
    expect(serialized).toContain("Here is the summary.");
  });
});

describe("emit + persist round-trip", () => {
  it("an emitted call lands in the persisted assistant message via the splice", () => {
    const bridge = createSubagentToolStreamBridge();
    bridge.setWriter({ write: vi.fn() });
    bridge.emit({
      parentToolCallId: "P1",
      toolCallId: "C1",
      toolName: "web_search",
      output: { ok: true },
    });

    const persisted = applySubagentToolCallsToMessages(
      [
        { role: "user", parts: [{ type: "text", text: "go" }] },
        {
          role: "assistant",
          parts: [
            {
              type: "tool-agent__child",
              toolCallId: "P1",
              state: "output-available",
            },
          ],
        },
      ],
      bridge.collected(),
    );

    expect(
      persisted[1].parts?.some((p) => p.type === SUBAGENT_TOOL_CALL_PART_TYPE),
    ).toBe(true);
  });
});

describe("createSubagentToolStreamBridge payload handling", () => {
  it("caps an oversized input the same way as output", () => {
    const bridge = createSubagentToolStreamBridge();
    const huge = "y".repeat(50_000);
    bridge.emit({
      parentToolCallId: "P1",
      toolCallId: "C1",
      toolName: "fetch",
      input: { body: huge },
    });
    const data = bridge.collected()[0]?.data as { input: unknown };
    expect(typeof data.input).toBe("string");
    expect((data.input as string).length).toBeLessThan(huge.length);
    expect(data.input as string).toContain("truncated");
  });

  it("caps an oversized errorText string", () => {
    const bridge = createSubagentToolStreamBridge();
    const huge = "boom ".repeat(5_000);
    bridge.emit({
      parentToolCallId: "P1",
      toolCallId: "C1",
      toolName: "fetch",
      errorText: huge,
    });
    const data = bridge.collected()[0]?.data as { errorText: string };
    expect(data.errorText.length).toBeLessThan(huge.length);
    expect(data.errorText).toContain("truncated");
  });

  it("replaces a value JSON.stringify cannot serialize (BigInt) with a marker", () => {
    const bridge = createSubagentToolStreamBridge();
    bridge.emit({
      parentToolCallId: "P1",
      toolCallId: "C1",
      toolName: "calc",
      output: { n: 10n },
    });
    const data = bridge.collected()[0]?.data as { output: unknown };
    expect(data.output).toBe("[unserializable]");
  });

  it("replaces a value with no JSON representation (a function) with a marker", () => {
    const bridge = createSubagentToolStreamBridge();
    bridge.emit({
      parentToolCallId: "P1",
      toolCallId: "C1",
      toolName: "calc",
      input: () => {},
    });
    const data = bridge.collected()[0]?.data as { input: unknown };
    expect(data.input).toBe("[unserializable]");
  });

  it("omits optional fields that were not provided", () => {
    const bridge = createSubagentToolStreamBridge();
    bridge.emit({ parentToolCallId: "P1", toolCallId: "C1", toolName: "noop" });
    const data = bridge.collected()[0]?.data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(
      ["parentToolCallId", "toolCallId", "toolName"].sort(),
    );
  });

  it("accumulates multiple emitted calls in order", () => {
    const bridge = createSubagentToolStreamBridge();
    bridge.emit({ parentToolCallId: "P1", toolCallId: "C1", toolName: "a" });
    bridge.emit({ parentToolCallId: "P1", toolCallId: "C2", toolName: "b" });
    const ids = bridge
      .collected()
      .map((p) => (p.data as { toolCallId: string }).toolCallId);
    expect(ids).toEqual(["C1", "C2"]);
  });
});

describe("applySubagentToolCallsToMessages routing", () => {
  it("returns the input unchanged when no assistant message follows the last user turn", () => {
    const input: ChatMessage[] = [
      { role: "user", parts: [{ type: "text", text: "go" }] },
    ];
    expect(
      applySubagentToolCallsToMessages(input, [subagentPart("P1", "C1")]),
    ).toBe(input);
  });

  it("routes each child to the assistant message holding its own delegation call", () => {
    const input: ChatMessage[] = [
      { role: "user", parts: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        parts: [
          {
            type: "tool-agent__a",
            toolCallId: "P1",
            state: "output-available",
          },
        ],
      },
      {
        role: "assistant",
        parts: [
          {
            type: "tool-agent__b",
            toolCallId: "P2",
            state: "output-available",
          },
        ],
      },
    ];
    const result = applySubagentToolCallsToMessages(input, [
      subagentPart("P1", "C1"),
      subagentPart("P2", "C2"),
    ]);
    const idsAt = (i: number) =>
      result[i].parts
        ?.filter((p) => p.type === SUBAGENT_TOOL_CALL_PART_TYPE)
        .map((p) => (p.data as { toolCallId: string }).toolCallId);
    expect(idsAt(1)).toEqual(["C1"]);
    expect(idsAt(2)).toEqual(["C2"]);
  });

  it("routes a part with a non-string parentToolCallId to the last assistant message", () => {
    const input: ChatMessage[] = [
      { role: "user", parts: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        parts: [
          {
            type: "tool-agent__a",
            toolCallId: "P1",
            state: "output-available",
          },
        ],
      },
    ];
    const orphan = {
      type: SUBAGENT_TOOL_CALL_PART_TYPE,
      data: { toolCallId: "X1", toolName: "fetch", state: "output-available" },
    } as unknown as ChatMessagePart;
    const result = applySubagentToolCallsToMessages(input, [orphan]);
    expect(
      result[1].parts?.some((p) => p.type === SUBAGENT_TOOL_CALL_PART_TYPE),
    ).toBe(true);
  });

  it("shallow-copies only the messages it touches", () => {
    const input: ChatMessage[] = [
      { role: "user", parts: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        parts: [
          {
            type: "tool-agent__a",
            toolCallId: "P1",
            state: "output-available",
          },
        ],
      },
      { role: "assistant", parts: [{ type: "text", text: "later" }] },
    ];
    const result = applySubagentToolCallsToMessages(input, [
      subagentPart("P1", "C1"),
    ]);
    expect(result[0]).toBe(input[0]);
    expect(result[2]).toBe(input[2]);
    expect(result[1]).not.toBe(input[1]);
  });
});

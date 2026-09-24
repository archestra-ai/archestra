import { describe, expect, it } from "vitest";
import type { ChatMessagePart } from "@/types";
import {
  applyHookRunsToMessages,
  type CollectedHookRun,
  HOOK_RUN_PART_TYPE,
  spliceHookRunParts,
  stripHookRunParts,
  toCollectedRuns,
} from "./hook-run-parts";

function text(t: string): ChatMessagePart {
  return { type: "text", text: t };
}

function tool(toolCallId: string, name = "todo_write"): ChatMessagePart {
  return { type: `tool-${name}`, toolCallId, state: "output-available" };
}

function run(
  partial: Partial<CollectedHookRun> & { anchor: CollectedHookRun["anchor"] },
): CollectedHookRun {
  return {
    hookEventName: "PreToolUse",
    fileName: "h.py",
    outcome: "proceeded",
    exitCode: 0,
    stdout: "",
    stderr: "",
    durationMs: 0,
    payload: {},
    ...partial,
  };
}

function types(parts: ChatMessagePart[]): string[] {
  return parts.map((p) => p.type);
}

function dataOf(part: ChatMessagePart): Record<string, unknown> {
  return part.data as Record<string, unknown>;
}

describe("spliceHookRunParts", () => {
  it("returns the same array reference when there are no runs", () => {
    const parts = [text("hi"), tool("a")];
    expect(spliceHookRunParts(parts, [])).toBe(parts);
  });

  it("places turn-start runs at the very top in input order", () => {
    const parts = [text("response")];
    const out = spliceHookRunParts(parts, [
      run({ hookEventName: "SessionStart", anchor: { kind: "turn-start" } }),
      run({
        hookEventName: "SessionStart",
        anchor: { kind: "turn-start" },
      }),
    ]);
    expect(types(out)).toEqual([
      HOOK_RUN_PART_TYPE,
      HOOK_RUN_PART_TYPE,
      "text",
    ]);
    expect(dataOf(out[0]).hookEventName).toBe("SessionStart");
    expect(dataOf(out[1]).hookEventName).toBe("SessionStart");
  });

  it("places tool-pre before and tool-post after the matching tool part", () => {
    const parts = [text("thinking"), tool("call-1"), text("done")];
    const out = spliceHookRunParts(parts, [
      run({ anchor: { kind: "tool-pre", toolCallId: "call-1" } }),
      run({
        hookEventName: "PostToolUse",
        anchor: { kind: "tool-post", toolCallId: "call-1" },
      }),
    ]);
    expect(types(out)).toEqual([
      "text",
      HOOK_RUN_PART_TYPE,
      "tool-todo_write",
      HOOK_RUN_PART_TYPE,
      "text",
    ]);
    expect(dataOf(out[1]).toolCallId).toBe("call-1");
  });

  it("appends turn-end runs at the end", () => {
    const out = spliceHookRunParts(
      [text("done")],
      [run({ hookEventName: "Stop", anchor: { kind: "turn-end" } })],
    );
    expect(types(out)).toEqual(["text", HOOK_RUN_PART_TYPE]);
  });

  it("keeps input order for multiple runs at the same anchor", () => {
    const out = spliceHookRunParts(
      [tool("call-1")],
      [
        run({
          fileName: "a.py",
          anchor: { kind: "tool-pre", toolCallId: "call-1" },
        }),
        run({
          fileName: "b.py",
          anchor: { kind: "tool-pre", toolCallId: "call-1" },
        }),
      ],
    );
    expect(types(out)).toEqual([
      HOOK_RUN_PART_TYPE,
      HOOK_RUN_PART_TYPE,
      "tool-todo_write",
    ]);
    expect(dataOf(out[0]).fileName).toBe("a.py");
    expect(dataOf(out[1]).fileName).toBe("b.py");
  });

  it("falls back to the end for an unmatched toolCallId (nothing dropped)", () => {
    const out = spliceHookRunParts(
      [text("no tools here")],
      [run({ anchor: { kind: "tool-pre", toolCallId: "missing" } })],
    );
    expect(types(out)).toEqual(["text", HOOK_RUN_PART_TYPE]);
  });

  it("does not mutate the input parts array", () => {
    const parts = [text("x")];
    spliceHookRunParts(parts, [
      run({ hookEventName: "Stop", anchor: { kind: "turn-end" } }),
    ]);
    expect(parts).toHaveLength(1);
  });
});

describe("toCollectedRuns", () => {
  it("maps run details onto an anchor, carrying toolName when given", () => {
    expect(
      toCollectedRuns(
        [
          {
            hookEventName: "PreToolUse",
            fileName: "g.py",
            outcome: "blocked",
            exitCode: 2,
            stdout: "out",
            stderr: "blocked!",
            durationMs: 12,
            payload: { tool_name: "bash" },
          },
        ],
        { kind: "tool-pre", toolCallId: "c1" },
        "bash",
      ),
    ).toEqual([
      {
        hookEventName: "PreToolUse",
        fileName: "g.py",
        outcome: "blocked",
        exitCode: 2,
        stdout: "out",
        stderr: "blocked!",
        durationMs: 12,
        payload: { tool_name: "bash" },
        toolName: "bash",
        anchor: { kind: "tool-pre", toolCallId: "c1" },
      },
    ]);
  });

  it("returns an empty array for undefined runs", () => {
    expect(toCollectedRuns(undefined, { kind: "turn-end" })).toEqual([]);
  });
});

describe("applyHookRunsToMessages", () => {
  const user = (t: string) => ({ role: "user" as const, parts: [text(t)] });
  const assistant = (parts: ChatMessagePart[]) => ({
    role: "assistant" as const,
    parts,
  });

  it("returns messages unchanged when the turn produced no assistant message", () => {
    const messages = [user("hello")];
    expect(
      applyHookRunsToMessages(messages, [
        run({
          hookEventName: "SessionStart",
          anchor: { kind: "turn-start" },
        }),
      ]),
    ).toBe(messages);
  });

  it("places turn-start / tool / turn-end runs in the assistant message in order", () => {
    const messages = [
      user("do it"),
      assistant([text("ok"), tool("call-1"), text("done")]),
    ];
    const out = applyHookRunsToMessages(messages, [
      run({
        hookEventName: "SessionStart",
        anchor: { kind: "turn-start" },
      }),
      run({ anchor: { kind: "tool-pre", toolCallId: "call-1" } }),
      run({ hookEventName: "Stop", anchor: { kind: "turn-end" } }),
    ]);
    expect(out[0]).toBe(messages[0]);
    expect(types(out[1].parts ?? [])).toEqual([
      HOOK_RUN_PART_TYPE,
      "text",
      HOOK_RUN_PART_TYPE,
      "tool-todo_write",
      "text",
      HOOK_RUN_PART_TYPE,
    ]);
  });

  it("routes a tool run to whichever assistant message holds the matching tool", () => {
    const messages = [
      user("go"),
      assistant([tool("call-1")]),
      assistant([text("final")]),
    ];
    const out = applyHookRunsToMessages(messages, [
      run({
        hookEventName: "PostToolUse",
        anchor: { kind: "tool-post", toolCallId: "call-1" },
      }),
    ]);
    expect(types(out[1].parts ?? [])).toEqual([
      "tool-todo_write",
      HOOK_RUN_PART_TYPE,
    ]);
    expect(out[2]).toBe(messages[2]);
  });
});

describe("hook-run part debug bodies", () => {
  it("emits payloadJson + durationMs, and stdout/stderr only when non-empty", () => {
    const [part] = spliceHookRunParts(
      [],
      [
        run({
          anchor: { kind: "turn-start" },
          stdout: "hello",
          stderr: "",
          durationMs: 42,
          payload: { a: 1 },
        }),
      ],
    );
    const d = dataOf(part);
    expect(d.payloadJson).toBe(JSON.stringify({ a: 1 }));
    expect(d.durationMs).toBe(42);
    expect(d.stdout).toBe("hello");
    expect(d).not.toHaveProperty("stderr");
  });

  it("truncates a body past the cap with a marker", () => {
    const big = "x".repeat(10_001);
    const [part] = spliceHookRunParts(
      [],
      [run({ anchor: { kind: "turn-start" }, stdout: big })],
    );
    expect(dataOf(part).stdout).toBe(
      `${"x".repeat(10_000)}…[truncated 1 chars]`,
    );
  });
});

describe("stripHookRunParts", () => {
  const hookPart = (): ChatMessagePart => ({
    type: HOOK_RUN_PART_TYPE,
    data: {
      hookEventName: "Stop",
      fileName: "s.py",
      outcome: "proceeded",
      exitCode: 0,
    },
  });
  const assistant = (parts: ChatMessagePart[]) => ({
    role: "assistant" as const,
    parts,
  });

  it("returns the same reference when visible", () => {
    const messages = [assistant([text("hi"), hookPart()])];
    expect(stripHookRunParts(messages, { visible: true })).toBe(messages);
  });

  it("removes hook parts when not visible, keeping other parts", () => {
    const out = stripHookRunParts(
      [assistant([text("hi"), hookPart(), tool("c1")])],
      { visible: false },
    );
    expect(types(out[0].parts ?? [])).toEqual(["text", "tool-todo_write"]);
  });

  it("leaves a message with no hook part untouched (same reference)", () => {
    const messages = [assistant([text("hi")])];
    const out = stripHookRunParts(messages, { visible: false });
    expect(out[0]).toBe(messages[0]);
  });
});

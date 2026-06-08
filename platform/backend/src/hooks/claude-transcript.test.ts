import { describe, expect, it } from "vitest";
import type { ChatMessage, ChatMessagePart } from "@/types";
import {
  messagesToClaudeTranscript,
  type TranscriptOptions,
} from "./claude-transcript";

const OPTS: TranscriptOptions = {
  sessionId: "conv-1",
  cwd: "/home/sandbox",
  model: "claude-opus-4-8",
  version: "archestra-test",
  timestamp: "2026-06-09T00:00:00.000Z",
};

interface TLine {
  type: string;
  parentUuid: string | null;
  uuid: string;
  sessionId: string;
  cwd: string;
  version: string;
  isSidechain: boolean;
  userType: string;
  gitBranch: string;
  message: Record<string, unknown>;
  toolUseResult?: unknown;
}

function parse(jsonl: string): TLine[] {
  return jsonl
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as TLine);
}

function user(text: string, id?: string): ChatMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}
function assistant(parts: ChatMessagePart[], id?: string): ChatMessage {
  return { id, role: "assistant", parts };
}

describe("messagesToClaudeTranscript", () => {
  it("returns an empty string when there are no renderable messages", () => {
    expect(messagesToClaudeTranscript([], OPTS)).toBe("");
  });

  it("emits one user line with a text block + the synthesized envelope fields", () => {
    const [line] = parse(messagesToClaudeTranscript([user("hi", "u1")], OPTS));
    expect(line.type).toBe("user");
    expect(line.parentUuid).toBeNull();
    expect(line.sessionId).toBe("conv-1");
    expect(line.cwd).toBe("/home/sandbox");
    expect(line.version).toBe("archestra-test");
    expect(line.isSidechain).toBe(false);
    expect(line.userType).toBe("external");
    expect(line.gitBranch).toBe("");
    expect(line.message).toEqual({
      role: "user",
      content: [{ type: "text", text: "hi" }],
    });
  });

  it("chains parentUuid across lines and stamps the model on assistant lines", () => {
    const lines = parse(
      messagesToClaudeTranscript(
        [user("hi", "u1"), assistant([{ type: "text", text: "yo" }], "a1")],
        OPTS,
      ),
    );
    expect(lines).toHaveLength(2);
    expect(lines[0].parentUuid).toBeNull();
    expect(lines[1].parentUuid).toBe(lines[0].uuid);
    expect(lines[1].type).toBe("assistant");
    expect(lines[1].message.model).toBe("claude-opus-4-8");
  });

  it("splits a tool call into an assistant tool_use line + a separate user tool_result line", () => {
    const lines = parse(
      messagesToClaudeTranscript(
        [
          user("do it", "u1"),
          assistant(
            [
              { type: "text", text: "calling" },
              {
                type: "tool-get_weather",
                toolCallId: "tc1",
                state: "output-available",
                input: { city: "NYC" },
                output: "sunny",
              },
            ],
            "a1",
          ),
        ],
        OPTS,
      ),
    );
    expect(lines).toHaveLength(3);
    expect(lines[1].type).toBe("assistant");
    expect(lines[1].message.content).toEqual([
      { type: "text", text: "calling" },
      {
        type: "tool_use",
        id: "tc1",
        name: "get_weather",
        input: { city: "NYC" },
      },
    ]);
    expect(lines[2].type).toBe("user");
    expect(lines[2].parentUuid).toBe(lines[1].uuid);
    expect(lines[2].message.content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "tc1",
        content: "sunny",
        is_error: false,
      },
    ]);
    expect(lines[2].toolUseResult).toBe("sunny");
  });

  it("maps reasoning to thinking and skips data-* / step-start parts", () => {
    const [line] = parse(
      messagesToClaudeTranscript(
        [
          assistant(
            [
              { type: "step-start" },
              { type: "reasoning", text: "hmm" },
              { type: "text", text: "answer" },
              { type: "data-hook-run", data: { fileName: "h.py" } },
            ],
            "a1",
          ),
        ],
        OPTS,
      ),
    );
    expect(line.message.content).toEqual([
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "answer" },
    ]);
  });

  it("produces newline-terminated JSONL whose lines are valid JSON", () => {
    const out = messagesToClaudeTranscript([user("hi", "u1")], OPTS);
    expect(out.endsWith("\n")).toBe(true);
    expect(() => JSON.parse(out.trim())).not.toThrow();
  });
});

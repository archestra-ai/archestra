import { describe, expect, it } from "vitest";
import { formatAgentRunReadableTranscript } from "./agent-run-readable-transcript";

describe("formatAgentRunReadableTranscript", () => {
  it("renders messages and correlated tool activity in chronological order", () => {
    const formatted = formatAgentRunReadableTranscript(
      JSON.stringify({
        version: 1,
        provider: "claude-code",
        entries: [
          { type: "message", role: "user", text: "Inspect the project" },
          {
            type: "tool_call",
            name: "Read",
            toolCallId: "tool-1",
            input: '{"file_path":"src/app.ts"}',
          },
          {
            type: "tool_result",
            toolCallId: "tool-1",
            text: "export const ready = true;",
          },
          { type: "message", role: "assistant", text: "The work is done" },
        ],
      }),
    );

    expect(formatted).toBe(
      [
        "User\nInspect the project",
        'Tool · Read\nArguments\n{\n  "file_path": "src/app.ts"\n}',
        "Tool result · Read\nexport const ready = true;",
        "Assistant\nThe work is done",
      ].join("\n\n"),
    );
  });

  it("rejects malformed or unsupported transcript payloads", () => {
    expect(formatAgentRunReadableTranscript("not json")).toBeNull();
    expect(
      formatAgentRunReadableTranscript(
        JSON.stringify({ version: 2, provider: "future", entries: [] }),
      ),
    ).toBeNull();
  });
});

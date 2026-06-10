import { describe, expect, it } from "vitest";
import { prettyPrintJson, splitHookPayload } from "./hook-run-chip.utils";

describe("prettyPrintJson", () => {
  it("indents valid JSON", () => {
    expect(prettyPrintJson('{"a":1,"b":{"c":2}}')).toBe(
      '{\n  "a": 1,\n  "b": {\n    "c": 2\n  }\n}',
    );
  });

  it("returns the raw string when it is not valid JSON (e.g. truncated)", () => {
    const truncated = '{"tool_name":"bash"…[truncated 1200 chars]';
    expect(prettyPrintJson(truncated)).toBe(truncated);
  });

  it("leaves an empty string untouched", () => {
    expect(prettyPrintJson("")).toBe("");
  });
});

describe("splitHookPayload", () => {
  it("separates tool_input and tool_response from the metadata fields", () => {
    const payload = splitHookPayload(
      JSON.stringify({
        tool_name: "archestra__run_command",
        tool_input: { command: "echo hi\necho bye" },
        tool_response: "Exit code: 0\n\nstdout:\nhi\nbye\n",
        session_id: "abc",
        cwd: "/home/sandbox",
        hook_event_name: "PostToolUse",
      }),
    );

    expect(payload).toEqual({
      toolInput: { command: "echo hi\necho bye" },
      toolResponse: "Exit code: 0\n\nstdout:\nhi\nbye\n",
      rest: {
        tool_name: "archestra__run_command",
        session_id: "abc",
        cwd: "/home/sandbox",
        hook_event_name: "PostToolUse",
      },
    });
  });

  it("omits the input/response keys for payloads without them (SessionStart)", () => {
    const payload = splitHookPayload(
      JSON.stringify({ source: "startup", hook_event_name: "SessionStart" }),
    );

    expect(payload).toEqual({
      rest: { source: "startup", hook_event_name: "SessionStart" },
    });
  });

  it("returns null for a truncated payload so the caller falls back to raw", () => {
    expect(
      splitHookPayload('{"tool_name":"bash"…[truncated 1200 chars]'),
    ).toBeNull();
  });

  it("returns null for non-object JSON", () => {
    expect(splitHookPayload('"just a string"')).toBeNull();
    expect(splitHookPayload("[1,2]")).toBeNull();
  });
});

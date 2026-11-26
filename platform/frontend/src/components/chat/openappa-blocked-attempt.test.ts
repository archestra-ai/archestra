import { describe, expect, it } from "vitest";
import { getBlockedAttempt } from "./openappa-blocked-attempt";

// Mirrors the gateway's naming: any prefix, then the tool's own name.
const getToolShortName = (name: string) =>
  (name.split("__").pop() ?? null) as never;

const notice = {
  tool: "fs__read_file",
  arguments: { path: "/notes.md" },
  ruling: "[appa] Blocked: fs__read_file cannot run yet.",
  notice: { v: 1, call_id: "call-1" },
};

const attempt = (
  input: unknown,
  state = "output-available",
  toolName = "archestra__get_remedy_plans",
) =>
  getBlockedAttempt({
    part: { input, state } as never,
    toolName,
    getToolShortName,
  });

describe("getBlockedAttempt", () => {
  it("returns the call the model tried, with its arguments", () => {
    expect(attempt(notice)).toEqual({
      toolName: "fs__read_file",
      input: { path: "/notes.md" },
    });
  });

  it("reads arguments that arrive as a JSON string", () => {
    expect(
      attempt({ ...notice, arguments: '{"path":"/notes.md"}' })?.input,
    ).toEqual({ path: "/notes.md" });
  });

  it("keeps arguments that are not JSON as they were sent", () => {
    expect(attempt({ ...notice, arguments: "not json" })?.input).toBe(
      "not json",
    );
  });

  it("shows a call without arguments as an empty request", () => {
    const { arguments: _omitted, ...withoutArguments } = notice;
    expect(attempt(withoutArguments)?.input).toEqual({});
  });

  it("recognizes the notice under a renamed gateway prefix", () => {
    expect(
      attempt(notice, "output-available", "sparky__get_remedy_plans"),
    ).not.toBeNull();
  });

  it("leaves a get_remedy_plans call without a notice as an ordinary call", () => {
    expect(attempt({})).toBeNull();
    expect(attempt({ tool: "fs__read_file" })).toBeNull();
    expect(attempt({ ...notice, notice: undefined })).toBeNull();
  });

  it("leaves every other tool alone, whatever its arguments", () => {
    expect(attempt(notice, "output-available", "fs__read_file")).toBeNull();
  });

  it("waits for the tool's whole name while the notice streams in", () => {
    // The name is the last field so far: it can still be growing.
    expect(attempt({ tool: "fs__re" }, "input-streaming")).toBeNull();
    // Another field follows it: the name is whole.
    expect(
      attempt({ tool: "fs__read_file", arguments: "{" }, "input-streaming"),
    ).toEqual({ toolName: "fs__read_file", input: "{" });
  });
});

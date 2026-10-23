import { describe, expect, test } from "vitest";
import { AppaPiAdapter } from "./pi";

const adapter = new AppaPiAdapter();

describe("Pi session identity", () => {
  test("resumes the native session and keeps a different session separate", () => {
    const identity = (id: string) =>
      adapter.extractSessionIdentity({
        headers: { "x-pi-session-id": id },
        requestBody: {},
      });
    expect(identity("session-one")).toEqual(identity("session-one"));
    expect(identity("session-two")).not.toEqual(identity("session-one"));
    expect(identity("session-one")).toEqual({
      sessionId: "session-one",
      provenance: "pi-session-header",
    });
  });

  test.each([
    {},
    { "x-pi-session-id": "" },
    { "x-pi-session-id": "session one" },
    { "x-pi-session-id": "x".repeat(513) },
    { "x-pi-session-id": ["first", "second"] },
    { "x-pi-session-id": "first", "X-Pi-Session-Id": "second" },
  ])("rejects a missing, invalid, or contradictory identity: %j", (headers) => {
    expect(() =>
      adapter.extractSessionIdentity({ headers, requestBody: {} }),
    ).toThrow("Pi must send one valid session ID");
  });

  test("does not identify arbitrary user agents as Pi", () => {
    expect(
      adapter.matches({
        headers: { "user-agent": "example-api-client" },
        requestBody: {},
      }),
    ).toBe(false);
    expect(
      adapter.matches({
        headers: { "x-archestra-agent-id": "pi" },
        requestBody: {},
      }),
    ).toBe(true);
  });
});

describe("Pi native tool identity", () => {
  test("keeps native tools local and recognizes Pi's MCP namespace", () => {
    for (const name of [
      "bash",
      "read",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
    ]) {
      expect(adapter.classifyToolName(name)).toBe("local");
      expect(adapter.normalizeLocalToolName(name)).toBe(name);
    }
    expect(adapter.classifyToolName("mcp__gateway__archestra__ask_user")).toBe(
      "gateway",
    );
    expect(adapter.classifyToolName("read", "mcp__files")).toBe("gateway");
    expect(adapter.classifyToolName("custom__local")).toBe("local");
  });
});

describe("Pi human review", () => {
  const question = "Approve this call?";
  const asked = {
    question,
    options: [{ label: "Approve" }, { label: "Deny" }],
  };
  const read = (answer: unknown) =>
    adapter.nativeQuestion.rulingFromResult(
      { content: JSON.stringify(answer) },
      asked,
    );

  test("only advertises the question bridge when the extension reports it", () => {
    expect(adapter.nativeQuestion.isAvailable({})).toBe(false);
    expect(
      adapter.nativeQuestion.isAvailable({
        "x-archestra-native-question": "pi_ask_user",
      }),
    ).toBe(true);
    expect(adapter.nativeQuestion.fromAskUser(asked)).toEqual(asked);
  });

  test.each([
    ["Approve", "approve"],
    ["Deny", "deny"],
  ])("reads an explicitly submitted %s", (selection, expected) => {
    expect(read({ question, status: "answered", selection })).toBe(expected);
  });

  test.each([
    "cancelled",
    "unavailable",
  ])("does not turn %s into a human decision", (status) => {
    expect(read({ question, status, selection: "Approve" })).toBe(status);
  });

  test.each([
    { question, selection: "Approve" },
    { question: "Another review", status: "answered", selection: "Approve" },
    { question, status: "answered", selection: ["Approve", "Deny"] },
    { question, status: "answered", selection: "Approve the next call" },
    { answers: { question: "Approve" } },
    "Approve",
    null,
  ])("refuses an unbound or ambiguous answer: %j", (answer) => {
    expect(read(answer)).toBe("unrecognized");
  });

  test("treats an error result as unavailable even if it contains Approve", () => {
    expect(
      adapter.nativeQuestion.rulingFromResult(
        {
          isError: true,
          content: JSON.stringify({
            question,
            status: "answered",
            selection: "Approve",
          }),
        },
        asked,
      ),
    ).toBe("unavailable");
  });
});

import { describe, expect, test } from "vitest";
import { agentRuntimeFailureReason } from "./failure-reason";

describe("image-owned failure envelopes", () => {
  const envelope = {
    version: 1,
    code: "my_agent.input_missing",
    message: "Select an input file and retry.",
  };
  test("accepts custom codes and preserves image-authored guidance", () => {
    expect(agentRuntimeFailureReason(`78\n${JSON.stringify(envelope)}\n`)).toBe(
      `${envelope.message} (Runtime exit status 78.)`,
    );
  });
  test.each([
    {},
    { ...envelope, version: 2 },
    { ...envelope, code: "" },
    { ...envelope, code: "x".repeat(129) },
    { ...envelope, message: " " },
    { ...envelope, message: "x".repeat(2001) },
    { ...envelope, message: "\x1b[31mError" },
    { ...envelope, message: 42 },
    { ...envelope, rawDiagnostics: "private" },
  ])("rejects invalid envelopes: %j", (value) => {
    expect(agentRuntimeFailureReason(`78\n${JSON.stringify(value)}`)).toBe(
      "The Agent Runtime turn exited with status 78",
    );
  });
  test("bounds bytes as well as message length", () => {
    expect(
      agentRuntimeFailureReason(
        `78\n${JSON.stringify({ ...envelope, message: "界".repeat(1500) })}`,
      ),
    ).toBe("The Agent Runtime turn exited with status 78");
  });
  test.each([
    "78",
    "78\n",
    "78\nnot-json",
    '78\n{"version":1',
  ])("falls back for absent or incomplete envelopes: %s", (result) => {
    expect(agentRuntimeFailureReason(result)).toBe(
      "The Agent Runtime turn exited with status 78",
    );
  });
});

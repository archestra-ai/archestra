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
      `${envelope.message}\n\nOpen the run logs to inspect the last output, then retry the run.`,
    );
  });
  test("renders the typed resolution from the shared envelope", () => {
    expect(
      agentRuntimeFailureReason(
        `75\n${JSON.stringify({
          version: 1,
          code: "terminal_start_failed",
          phase: "terminal",
          message: "The runtime could not start the agent terminal.",
          resolution: "Check the runtime startup logs, then retry the run.",
        })}`,
      ),
    ).toBe(
      "The runtime could not start the agent terminal.\n\nCheck the runtime startup logs, then retry the run.",
    );
  });
  test("gives a typed actionable fallback for an unannotated status 75", () => {
    expect(agentRuntimeFailureReason("75")).toBe(
      "The runtime became unavailable before a result was recorded.\n\nReview the run logs and runtime capacity, then retry after the runtime is available.",
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
      "The agent stopped without reporting a structured failure reason.\n\nOpen the run logs to inspect the last output, then check the agent configuration before retrying. (Runtime exit status 78.)",
    );
  });
  test("bounds bytes as well as message length", () => {
    expect(
      agentRuntimeFailureReason(
        `78\n${JSON.stringify({ ...envelope, message: "界".repeat(1500) })}`,
      ),
    ).toBe(
      "The agent stopped without reporting a structured failure reason.\n\nOpen the run logs to inspect the last output, then check the agent configuration before retrying. (Runtime exit status 78.)",
    );
  });
  test.each([
    "78",
    "78\n",
    "78\nnot-json",
    '78\n{"version":1',
  ])("falls back for absent or incomplete envelopes: %s", (result) => {
    expect(agentRuntimeFailureReason(result)).toBe(
      "The agent stopped without reporting a structured failure reason.\n\nOpen the run logs to inspect the last output, then check the agent configuration before retrying. (Runtime exit status 78.)",
    );
  });
});

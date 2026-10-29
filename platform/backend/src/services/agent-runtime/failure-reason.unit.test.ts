import { describe, expect, test } from "vitest";
import {
  agentRuntimeFailureReason,
  agentRuntimeTurnFailure,
} from "./failure-reason";

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

describe("turn failure classification", () => {
  const result = (code: string) =>
    `75\n${JSON.stringify({ version: 1, code, message: "Safe message." })}`;

  test.each([
    // Platform-owned supervisor and credential-projection envelopes.
    ["runtime.interrupted", "turn.interrupted", true],
    ["runtime.recording_failed", "turn.recording_failed", true],
    ["runtime.pane_exited", "turn.process_exited", false],
    [
      "runtime.credential_projection_timeout",
      "launch.credentials_timeout",
      true,
    ],
    // Maintained images: transient provider, proxy and startup problems.
    ["claude_rate_limit", "image.claude_rate_limit", true],
    ["claude_unavailable", "image.claude_unavailable", true],
    ["kimi_unavailable", "image.kimi_unavailable", true],
    ["proxy_unavailable", "image.proxy_unavailable", true],
    ["mcp_startup", "image.mcp_startup", true],
    ["task_submission", "image.task_submission", true],
    // Maintained images: credential, account, request and protocol errors.
    ["claude_authentication", "image.claude_authentication", false],
    ["claude_billing", "image.claude_billing", false],
    ["claude_request", "image.claude_request", false],
    ["claude_api_error", "image.claude_api_error", false],
    ["github_configuration", "image.github_configuration", false],
    ["github_credential_rejected", "image.github_credential_rejected", false],
    ["codex_protocol", "image.codex_protocol", false],
    ["codex_startup", "image.codex_startup", false],
    ["codex_turn_failed", "image.codex_turn_failed", false],
    ["opencode_session_error", "image.opencode_session_error", false],
    ["kimi_turn_failed", "image.kimi_turn_failed", false],
    ["kimi_protocol", "image.kimi_protocol", false],
    // Custom images own their vocabulary; unknown codes are not retriable.
    ["my_agent.input_missing", "image.my_agent.input_missing", false],
  ])("classifies envelope %s as %s", (envelopeCode, code, retriable) => {
    expect(agentRuntimeTurnFailure(result(envelopeCode))).toEqual({
      code,
      retriable,
    });
  });

  test.each([
    "78",
    "78\nnot-json",
    `78\n${JSON.stringify({ version: 2, code: "claude_rate_limit", message: "x" })}`,
  ])("an exit without a valid envelope is turn.exit_status: %s", (value) => {
    expect(agentRuntimeTurnFailure(value)).toEqual({
      code: "turn.exit_status",
      retriable: false,
    });
  });
});

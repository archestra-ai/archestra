import { describe, expect, test } from "vitest";
import {
  buildNoPolicyUntrustedReason,
  buildUntrustedContextPolicyReason,
  isSensitiveContextPolicyDeniedReason,
  TOOL_INVOCATION_NO_POLICY_UNTRUSTED_REASON,
  TOOL_INVOCATION_UNTRUSTED_CONTEXT_REASON,
} from "./tool-invocation-policy-reasons";

describe("buildUntrustedContextPolicyReason", () => {
  test("falls back to the generic wording when the origin is unknown", () => {
    expect(buildUntrustedContextPolicyReason()).toBe(
      TOOL_INVOCATION_UNTRUSTED_CONTEXT_REASON,
    );
  });

  test("names the tool whose result flipped the session", () => {
    expect(
      buildUntrustedContextPolicyReason({
        kind: "tool_result",
        toolName: "Bash",
      }),
    ).toBe(
      '"Block in sensitive context" tool call policy violated: this session contains sensitive data, introduced by an earlier "Bash" tool result',
    );
  });

  test("names the agent setting when the agent starts every session sensitive", () => {
    expect(
      buildUntrustedContextPolicyReason({ kind: "agent_configured" }),
    ).toBe(
      '"Block in sensitive context" tool call policy violated: this agent is configured to treat every session as sensitive from the start',
    );
  });

  test("names delegation when the sensitive state was inherited", () => {
    expect(
      buildUntrustedContextPolicyReason({ kind: "inherited_from_parent" }),
    ).toBe(
      '"Block in sensitive context" tool call policy violated: this session inherited sensitive context from the conversation that delegated to it',
    );
  });
});

describe("buildNoPolicyUntrustedReason", () => {
  test("falls back to the generic wording when the origin is unknown", () => {
    expect(buildNoPolicyUntrustedReason()).toBe(
      TOOL_INVOCATION_NO_POLICY_UNTRUSTED_REASON,
    );
  });

  test("names the tool whose result flipped the session", () => {
    expect(
      buildNoPolicyUntrustedReason({ kind: "tool_result", toolName: "Read" }),
    ).toBe(
      'Blocked by default in sensitive context: this session contains sensitive data, introduced by an earlier "Read" tool result, and no tool call policy explicitly allows this tool in that state',
    );
  });
});

describe("isSensitiveContextPolicyDeniedReason", () => {
  test("matches the generic current reasons", () => {
    expect(
      isSensitiveContextPolicyDeniedReason(
        TOOL_INVOCATION_UNTRUSTED_CONTEXT_REASON,
      ),
    ).toBe(true);
    expect(
      isSensitiveContextPolicyDeniedReason(
        TOOL_INVOCATION_NO_POLICY_UNTRUSTED_REASON,
      ),
    ).toBe(true);
  });

  test("matches origin-enriched reasons", () => {
    expect(
      isSensitiveContextPolicyDeniedReason(
        buildUntrustedContextPolicyReason({
          kind: "tool_result",
          toolName: "Bash",
        }),
      ),
    ).toBe(true);
    expect(
      isSensitiveContextPolicyDeniedReason(
        buildNoPolicyUntrustedReason({ kind: "agent_configured" }),
      ),
    ).toBe(true);
  });

  test("matches legacy persisted reasons", () => {
    expect(
      isSensitiveContextPolicyDeniedReason(
        "Tool call blocked: context contains sensitive data",
      ),
    ).toBe(true);
  });

  test("rejects unrelated reasons", () => {
    expect(
      isSensitiveContextPolicyDeniedReason(
        '"Block always" tool call policy violated: this tool is blocked for every call',
      ),
    ).toBe(false);
  });
});

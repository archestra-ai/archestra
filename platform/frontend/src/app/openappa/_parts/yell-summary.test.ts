// @vitest-environment node
import { describe, expect, test } from "vitest";
import { yellSummary } from "./yell-summary";

function report(tools: string, reason: string) {
  return `Affected tools: ${tools}.\n\nOriginal refusal:\n${reason}\n\nResult: Enforcement disabled.\n\nTechnical boundary: onToolCalls.`;
}

describe("yell row summary", () => {
  test("shows the return restriction without the generic waiver instructions", () => {
    expect(
      yellSummary({
        kind: "block_waived",
        message: report(
          "Not attributed (session operation)",
          "[appa] Your parent takes no return from you. End with an empty final message.",
        ),
      }),
    ).toBe("Your parent takes no return from you");
  });

  test("uses the native cause and does not repeat an already named tool", () => {
    expect(
      yellSummary({
        kind: "block_waived",
        message: report(
          "ToolSearch",
          "OpenAPPA could not safely complete an operation.\nCaused by: OpenAPPA processing interrupted: tool host/archestra/ToolSearch is not declared in this policy",
        ),
      }),
    ).toBe("tool host/archestra/ToolSearch is not declared in this policy");
  });

  test("selects the ruling's reason and retains the affected tool", () => {
    expect(
      yellSummary({
        kind: "approval_waived",
        message: report(
          "send_message",
          "[appa] Blocked: this call cannot run yet.\n\nWhy:\n  - The recipient is outside the permitted audience.\n\nContinue:\n  - Ask for approval.",
        ),
      }),
    ).toBe("send_message: The recipient is outside the permitted audience");
  });

  test("preserves ordinary reports and legacy waiver messages", () => {
    const message = "Original refusal:\nAn agent's own report";
    expect(yellSummary({ kind: "agent", message })).toBe(
      "Original refusal: An agent's own report",
    );
    expect(
      yellSummary({ kind: "block_waived", message: "Legacy waiver\nreport" }),
    ).toBe("Legacy waiver report");
  });
});

// Client-visible reasons for blocked tool calls. Each is a single line that
// quotes the policy action exactly as the admin sees it in the policy editor
// ("Block always" / "Block in sensitive context" / "Require approval"), then
// says why it fired — the refusal template renders it verbatim, so no extra
// framing line is needed around it.

export const TOOL_INVOCATION_BLOCK_ALWAYS_REASON =
  '"Block always" tool call policy violated: this tool is blocked for every call';

/**
 * Frame an admin-authored policy reason with the policy that fired, falling
 * back to the generic wording when the admin wrote none.
 */
export function buildBlockAlwaysPolicyReason(
  customReason?: string | null,
): string {
  return customReason
    ? `"Block always" tool call policy violated: ${customReason}`
    : TOOL_INVOCATION_BLOCK_ALWAYS_REASON;
}

export const TOOL_INVOCATION_APPROVAL_REQUIRED_AUTONOMOUS_REASON =
  '"Require approval" tool call policy could not be satisfied: human approval is not available in autonomous sessions (A2A, Slack, MS Teams, sub-agents)';

export const TOOL_INVOCATION_DISABLED_FOR_CONVERSATION_REASON =
  "Tool is not enabled for this conversation";

export const TOOL_INVOCATION_UNTRUSTED_CONTEXT_REASON =
  '"Block in sensitive context" tool call policy violated: this session contains sensitive data (likely introduced by an earlier tool result)';

export const TOOL_INVOCATION_NO_POLICY_UNTRUSTED_REASON =
  "Blocked by default in sensitive context: this session contains sensitive data and no tool call policy explicitly allows this tool in that state";

const CURRENT_SENSITIVE_CONTEXT_POLICY_DENIAL_REASONS = new Set([
  TOOL_INVOCATION_UNTRUSTED_CONTEXT_REASON,
  TOOL_INVOCATION_NO_POLICY_UNTRUSTED_REASON,
]);

// Keep accepting these legacy forms because historical persisted refusals,
// interaction logs, and older clients may still contain them.
const LEGACY_SENSITIVE_CONTEXT_POLICY_DENIAL_REASONS = new Set([
  "Tool call blocked: context contains sensitive data",
  "Tool call blocked: forbidden in sensitive context by default",
  "Tool invocation blocked: context contains sensitive data",
  "Tool invocation blocked: forbidden in sensitive context by default",
  "context contains sensitive data",
  "forbidden in sensitive context by default",
]);

export function isSensitiveContextPolicyDeniedReason(reason: string): boolean {
  return (
    CURRENT_SENSITIVE_CONTEXT_POLICY_DENIAL_REASONS.has(reason) ||
    LEGACY_SENSITIVE_CONTEXT_POLICY_DENIAL_REASONS.has(reason)
  );
}

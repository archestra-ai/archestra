export const TOOL_INVOCATION_BLOCKED_PREFIX = "Tool call blocked";

function buildToolInvocationBlockedReason(detail: string): string {
  return `${TOOL_INVOCATION_BLOCKED_PREFIX}: ${detail}`;
}

export const TOOL_INVOCATION_BLOCK_ALWAYS_REASON =
  buildToolInvocationBlockedReason(
    "policy is configured to always block tool call",
  );

export const TOOL_INVOCATION_APPROVAL_REQUIRED_AUTONOMOUS_REASON =
  buildToolInvocationBlockedReason(
    "this tool requires human approval which is not available in autonomous agent sessions (A2A, Slack, MS Teams, sub-agents)",
  );

export const TOOL_INVOCATION_DISABLED_FOR_CONVERSATION_REASON =
  buildToolInvocationBlockedReason("tool not enabled for this conversation");

export const TOOL_INVOCATION_UNTRUSTED_CONTEXT_REASON =
  buildToolInvocationBlockedReason("context contains sensitive data");

export const TOOL_INVOCATION_NO_POLICY_UNTRUSTED_REASON =
  buildToolInvocationBlockedReason("forbidden in sensitive context by default");

const CURRENT_SENSITIVE_CONTEXT_POLICY_DENIAL_REASONS = new Set([
  TOOL_INVOCATION_UNTRUSTED_CONTEXT_REASON,
  TOOL_INVOCATION_NO_POLICY_UNTRUSTED_REASON,
]);

// Keep accepting these legacy forms because historical persisted refusals,
// interaction logs, and older clients may still contain them.
const LEGACY_SENSITIVE_CONTEXT_POLICY_DENIAL_REASONS = new Set([
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

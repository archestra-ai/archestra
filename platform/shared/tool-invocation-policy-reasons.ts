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

/**
 * What flipped the session into the sensitive state, when the enforcement
 * point knows it. Blocked-call reasons name this origin so a user (or their
 * admin) can see exactly which tool's data policy — or which agent setting —
 * made the session sensitive, instead of the generic "likely introduced by an
 * earlier tool result" guess.
 */
export type SensitiveContextOrigin =
  | { kind: "tool_result"; toolName: string }
  | { kind: "agent_configured" }
  | { kind: "inherited_from_parent" };

/**
 * Reason for a "Block in sensitive context" policy violation, naming the
 * origin of the sensitive state when known. Must stay a single paragraph:
 * the refusal prose parser reads the reason as the paragraph following the
 * blocked-call header.
 */
export function buildUntrustedContextPolicyReason(
  origin?: SensitiveContextOrigin,
): string {
  const originClause = describeSensitiveContextOrigin(origin);
  return originClause
    ? `${SENSITIVE_CONTEXT_POLICY_REASON_PREFIX} ${originClause}`
    : TOOL_INVOCATION_UNTRUSTED_CONTEXT_REASON;
}

/**
 * Reason for the default block applied when the session is sensitive and no
 * policy explicitly allows the tool, naming the origin of the sensitive state
 * when known.
 */
export function buildNoPolicyUntrustedReason(
  origin?: SensitiveContextOrigin,
): string {
  const originClause = describeSensitiveContextOrigin(origin);
  return originClause
    ? `${NO_POLICY_SENSITIVE_CONTEXT_REASON_PREFIX} ${originClause}, and no tool call policy explicitly allows this tool in that state`
    : TOOL_INVOCATION_NO_POLICY_UNTRUSTED_REASON;
}

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
    // Prefix match: current reasons share a stable prefix but may append the
    // origin of the sensitive state (e.g. the tool whose result flipped it).
    reason.startsWith(SENSITIVE_CONTEXT_POLICY_REASON_PREFIX) ||
    reason.startsWith(NO_POLICY_SENSITIVE_CONTEXT_REASON_PREFIX) ||
    LEGACY_SENSITIVE_CONTEXT_POLICY_DENIAL_REASONS.has(reason)
  );
}

// Stable prefixes shared by every variant of the two current reasons; the
// origin-specific tail varies, so classification matches on these.
const SENSITIVE_CONTEXT_POLICY_REASON_PREFIX =
  '"Block in sensitive context" tool call policy violated:';

const NO_POLICY_SENSITIVE_CONTEXT_REASON_PREFIX =
  "Blocked by default in sensitive context:";

function describeSensitiveContextOrigin(
  origin?: SensitiveContextOrigin,
): string | null {
  if (!origin) {
    return null;
  }
  switch (origin.kind) {
    case "tool_result":
      return `this session contains sensitive data, introduced by an earlier "${origin.toolName}" tool result`;
    case "agent_configured":
      return "this agent is configured to treat every session as sensitive from the start";
    case "inherited_from_parent":
      return "this session inherited sensitive context from the conversation that delegated to it";
  }
}

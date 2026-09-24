import type { OpenAppaPolicyTargetKind } from "@archestra/shared";

const POLICY_TARGET_KINDS: readonly OpenAppaPolicyTargetKind[] = [
  "agent",
  "mcp_gateway",
  "mcp_server",
];

/**
 * Resolves the `targetType`/`targetName` query params shared by the
 * `/openappa/configure` and `/openappa/[conversationId]` routes into a policy
 * target. Both routes need this: `configure` scopes the pre-conversation
 * welcome screen, and `[conversationId]` re-derives it after the
 * create-and-redirect handoff (see `PolicyChatStarter`'s `submit`) so the
 * target scope survives that navigation instead of being dropped.
 */
export function resolveOpenAppaPolicyTarget(searchParams: {
  targetType?: string;
  targetName?: string;
}): { kind: OpenAppaPolicyTargetKind; name: string } | undefined {
  const { targetType, targetName } = searchParams;
  if (!isPolicyTargetKind(targetType) || !targetName) return undefined;
  return { kind: targetType, name: targetName };
}

function isPolicyTargetKind(
  value: string | undefined,
): value is OpenAppaPolicyTargetKind {
  return (
    value !== undefined &&
    (POLICY_TARGET_KINDS as readonly string[]).includes(value)
  );
}

import { ChatOpenAppaPolicyTargetMetadataSchema } from "@archestra/shared";

/**
 * Resolves the `targetType`/`targetId` query params shared by the
 * `/openappa/configure` and `/openappa/[conversationId]` routes into a policy
 * target. Both routes need this: `configure` scopes the pre-conversation
 * welcome screen, and `[conversationId]` re-derives it after the
 * create-and-redirect handoff (see `PolicyChatStarter`'s `submit`) so the
 * target scope survives that navigation instead of being dropped.
 */
export function resolveOpenAppaPolicyTarget(searchParams: {
  targetType?: string;
  targetId?: string;
}) {
  const { targetType, targetId } = searchParams;
  const target = ChatOpenAppaPolicyTargetMetadataSchema.safeParse({
    kind: targetType,
    id: targetId,
  });
  return target.success ? target.data : undefined;
}

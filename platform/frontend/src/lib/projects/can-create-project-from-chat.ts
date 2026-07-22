/**
 * Whether the "Create project from chat" action should be offered for a chat.
 * Mirrors the backend eligibility (`project:create` permission, the chat is a
 * user chat not already in a project) so the menu item only appears when the
 * action would actually succeed.
 */
export function canCreateProjectFromChat(params: {
  hasCreatePermission: boolean;
  conversation: { projectId?: string | null; origin: string };
}): boolean {
  const { hasCreatePermission, conversation } = params;
  return (
    hasCreatePermission &&
    !conversation.projectId &&
    conversation.origin === "user"
  );
}

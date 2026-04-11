export function resolveSharedConversationForkState(params: {
  availableAgentIds: string[];
  selectedAgentId: string | null;
  sharedConversationAgentId: string | null;
}) {
  const accessibleSharedAgentId =
    params.sharedConversationAgentId &&
    params.availableAgentIds.includes(params.sharedConversationAgentId)
      ? params.sharedConversationAgentId
      : null;

  return {
    accessibleSharedAgentId,
    shouldPromptForForkAgentSelection: accessibleSharedAgentId === null,
    effectiveAgentId: params.selectedAgentId ?? accessibleSharedAgentId ?? null,
  };
}

/**
 * Builds the `/chat` handoff URL used when a chat is started from a project.
 *
 * The selected agent is forwarded as `agentId` so `/chat` opens with exactly
 * the agent picked in the project composer. The URL param is the highest
 * priority in the chat agent-resolution chain, ahead of the org default agent
 * and the permission-gated saved pick that would otherwise override it — so
 * relying on the saved-agent store alone did not reliably respect the choice.
 *
 * `hasAttachments` stamps an `attachments=1` marker when the composer stashed
 * files for this handoff (see `pending-chat-handoff-files`). `/chat` only drains
 * those stashed files when the marker is present, which both binds them to this
 * specific handoff (the auto-send path is shared by every handoff type) and
 * triggers the send for a files-only handoff that carries no prompt.
 */
export function buildProjectChatHandoffUrl(params: {
  projectId: string;
  prompt: string;
  agentId: string;
  hasAttachments?: boolean;
}): string {
  const search = new URLSearchParams({
    project: params.projectId,
    agentId: params.agentId,
  });
  // A files-only handoff carries no prompt; omit the empty param.
  if (params.prompt) {
    search.set("user_prompt", params.prompt);
  }
  if (params.hasAttachments) {
    search.set("attachments", "1");
  }
  return `/chat?${search.toString()}`;
}

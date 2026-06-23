/**
 * Builds the `/chat` handoff URL used when a chat is started from a project.
 *
 * The selected agent is forwarded as `agentId` so `/chat` opens with exactly
 * the agent picked in the project composer. The URL param is the highest
 * priority in the chat agent-resolution chain, ahead of the org default agent
 * and the permission-gated saved pick that would otherwise override it — so
 * relying on the saved-agent store alone did not reliably respect the choice.
 */
export function buildProjectChatHandoffUrl(params: {
  projectId: string;
  prompt: string;
  agentId: string;
}): string {
  const search = new URLSearchParams({
    project: params.projectId,
    user_prompt: params.prompt,
    agentId: params.agentId,
  });
  return `/chat?${search.toString()}`;
}

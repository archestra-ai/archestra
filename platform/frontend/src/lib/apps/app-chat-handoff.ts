/**
 * Builds the `/chat` handoff URL used when starting a chat from an app's page.
 *
 * The app name and id are folded into the auto-sent `user_prompt` so the agent
 * can call `render_app` with the exact id and mount this app inline. We don't
 * forward an `agentId` — apps aren't bound to an agent, so chat falls back to
 * its normal agent-resolution chain.
 */
export function buildAppChatHandoffUrl(params: {
  appId: string;
  appName: string;
}): string {
  const search = new URLSearchParams({
    user_prompt: `Open the "${params.appName}" app (app id: ${params.appId}).`,
  });
  return `/chat?${search.toString()}`;
}

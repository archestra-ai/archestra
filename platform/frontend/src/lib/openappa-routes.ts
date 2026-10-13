/**
 * A new chat with the agent. A prompt is sent right away; without one the chat
 * opens on the agent's suggested prompts.
 */
export function openAppaChatHref(agentId: string, prompt?: string): string {
  return `/chat?${new URLSearchParams({
    agentId,
    ...(prompt ? { user_prompt: prompt } : {}),
  })}`;
}

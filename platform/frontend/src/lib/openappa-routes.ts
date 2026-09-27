export function openAppaChatHref(agentId: string, prompt: string): string {
  return `/chat?${new URLSearchParams({ agentId, user_prompt: prompt })}`;
}

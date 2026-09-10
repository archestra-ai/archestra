import { AgentRunChatSession } from "../page.client";

export default async function AgentRunPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <AgentRunChatSession taskId={id} />;
}

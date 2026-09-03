import { AgentRunChatSession } from "../page.client";

export default async function AgentRunChatPage({
  params,
}: {
  params: Promise<{ taskId: string }>;
}) {
  const { taskId } = await params;
  return <AgentRunChatSession taskId={taskId} />;
}

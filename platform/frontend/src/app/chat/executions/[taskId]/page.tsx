import { BackgroundExecutionChatSession } from "../page.client";

export default async function AgentExecutionChatPage({
  params,
}: {
  params: Promise<{ taskId: string }>;
}) {
  const { taskId } = await params;
  return <BackgroundExecutionChatSession taskId={taskId} />;
}

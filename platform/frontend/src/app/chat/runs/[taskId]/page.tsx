import { permanentRedirect } from "next/navigation";

export default async function LegacyAgentRunPage({
  params,
}: {
  params: Promise<{ taskId: string }>;
}) {
  const { taskId } = await params;
  permanentRedirect(`/agent/run/${taskId}`);
}

import { AgentDetailPage } from "@/components/agent-pages/agent-detail-page";

export const dynamic = "force-dynamic";

export default async function LlmProxyDetailPageServer({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <AgentDetailPage kind="llm_proxy" id={decodeURIComponent(id)} />;
}

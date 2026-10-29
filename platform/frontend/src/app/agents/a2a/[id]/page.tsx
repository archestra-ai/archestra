import { A2aRemoteAgentDetailPage } from "@/components/a2a-remote-agent-page";

export default async function A2aRemoteAgentDetailPageServer({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <A2aRemoteAgentDetailPage id={decodeURIComponent(id)} />;
}

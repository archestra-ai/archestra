import { AgentConfigurationRedirect } from "@/components/agent-pages/agent-configuration-redirect";

export const dynamic = "force-dynamic";

export default async function AgentEditPageServer({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <AgentConfigurationRedirect kind="agent" id={decodeURIComponent(id)} />
  );
}

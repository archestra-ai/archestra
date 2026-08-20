import { AgentCreatePage } from "@/components/agent-pages/agent-create-page";

export const dynamic = "force-dynamic";

export default function NewLlmProxyPageServer() {
  return <AgentCreatePage kind="llm_proxy" />;
}

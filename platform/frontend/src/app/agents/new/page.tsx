import { AgentCreatePage } from "@/components/agent-pages/agent-create-page";

/**
 * Every choice on this page, including connecting an external agent over A2A,
 * needs Agent create, the same permission the backend checks. The client page
 * guard refuses the route without it (`requiredPagePermissionsMap`), so the
 * page only renders for a reader who can create agents.
 */
export default function NewAgentPageServer() {
  return <AgentCreatePage kind="agent" canCreateAgent />;
}

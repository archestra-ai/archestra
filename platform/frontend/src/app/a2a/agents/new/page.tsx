import { ForbiddenPage } from "@/app/_parts/forbidden-page";
import { CreateA2aRemoteAgentPage } from "@/components/a2a-remote-agent-page";
import { serverCanAccessPage } from "@/lib/auth/auth.server";

export const dynamic = "force-dynamic";

export default async function NewA2aRemoteAgentPageServer() {
  if (!(await serverCanAccessPage("/a2a/agents"))) {
    return <ForbiddenPage />;
  }
  return <CreateA2aRemoteAgentPage />;
}

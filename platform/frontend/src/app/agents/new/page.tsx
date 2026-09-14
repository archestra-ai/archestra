import type { ErrorExtended } from "@archestra/shared";

import { ForbiddenPage } from "@/app/_parts/forbidden-page";
import { AgentCreatePage } from "@/components/agent-pages/agent-create-page";
import { ServerErrorFallback } from "@/components/error-fallback";
import { serverHasPermissions } from "@/lib/auth/auth.server";

export const dynamic = "force-dynamic";

export default async function NewAgentPageServer() {
  try {
    const [canCreateAgent, canAddExternalAgent] = await Promise.all([
      serverHasPermissions({ agent: ["create"] }),
      serverHasPermissions({
        agent: ["read"],
        agentSettings: ["update"],
      }),
    ]);

    if (!canCreateAgent && !canAddExternalAgent) {
      return <ForbiddenPage />;
    }

    return (
      <AgentCreatePage
        kind="agent"
        canCreateAgent={canCreateAgent}
        canAddExternalAgent={canAddExternalAgent}
      />
    );
  } catch (error) {
    return <ServerErrorFallback error={error as ErrorExtended} />;
  }
}

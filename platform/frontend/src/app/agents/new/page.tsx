import type { ErrorExtended } from "@archestra/shared";

import { ForbiddenPage } from "@/app/_parts/forbidden-page";
import { AgentCreatePage } from "@/components/agent-pages/agent-create-page";
import { ServerErrorFallback } from "@/components/error-fallback";
import { serverHasPermissions } from "@/lib/auth/auth.server";

export const dynamic = "force-dynamic";

export default async function NewAgentPageServer() {
  try {
    // Every choice on this page, including connecting an external agent over
    // A2A, needs Agent create, the same permission the backend checks.
    const canCreateAgent = await serverHasPermissions({ agent: ["create"] });

    if (!canCreateAgent) {
      return <ForbiddenPage />;
    }

    return <AgentCreatePage kind="agent" canCreateAgent />;
  } catch (error) {
    return <ServerErrorFallback error={error as ErrorExtended} />;
  }
}

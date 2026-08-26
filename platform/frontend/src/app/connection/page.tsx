"use client";

import { useDefaultMcpGateway } from "@/lib/agent.query";
import { useLlmProxy } from "@/lib/llm-proxy.query";
import { useOrganization } from "@/lib/organization.query";
import { ConnectionFlow } from "./connection-flow";
import { getConnectableProviders } from "./connection-flow.utils";
import { ConnectionHero } from "./connection-hero";

export default function ConnectionPage() {
  const { data: defaultMcpGateway } = useDefaultMcpGateway();
  const { data: llmProxy } = useLlmProxy();
  const { data: organization } = useOrganization();

  const adminDefaultMcpGatewayId =
    organization?.connectionDefaultMcpGatewayId ?? null;
  const adminDefaultClientId = organization?.connectionDefaultClientId ?? null;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[1680px] px-6 py-6">
        <div className="mb-7 flex flex-wrap items-start justify-between gap-4">
          <ConnectionHero />
        </div>

        <ConnectionFlow
          defaultMcpGatewayId={defaultMcpGateway?.id}
          llmProxyId={llmProxy?.id}
          adminDefaultMcpGatewayId={adminDefaultMcpGatewayId}
          adminDefaultClientId={adminDefaultClientId}
          shownClientIds={organization?.connectionShownClientIds ?? null}
          shownProviders={getConnectableProviders(organization)}
          connectionBaseUrls={organization?.connectionBaseUrls ?? null}
        />
      </div>
    </div>
  );
}

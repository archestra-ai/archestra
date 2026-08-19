"use client";

import { useDefaultLlmProxy, useDefaultMcpGateway } from "@/lib/agent.query";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import { useOrganization } from "@/lib/organization.query";
import { useMyResourceAccess } from "@/lib/role-resource-access.query";
import { ConnectSettingsDialog } from "./connect-settings-dialog";
import { ConnectionFlow } from "./connection-flow";
import { ConnectionHero } from "./connection-hero";

export default function ConnectionPage() {
  const { data: defaultMcpGateway } = useDefaultMcpGateway();
  const { data: defaultLlmProxy } = useDefaultLlmProxy();
  const { data: organization } = useOrganization();
  // What the viewer's role offers, not what the organization owns.
  const { connectClients } = useMyResourceAccess();
  const providerCatalog = useModelProviderCatalog();

  const adminDefaultMcpGatewayId =
    organization?.connectionDefaultMcpGatewayId ?? null;
  const adminDefaultLlmProxyId =
    organization?.connectionDefaultLlmProxyId ?? null;
  const adminDefaultClientId = organization?.connectionDefaultClientId ?? null;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[1680px] px-6 py-6">
        <div className="mb-7 flex flex-wrap items-start justify-between gap-4">
          <ConnectionHero />
          <ConnectSettingsDialog />
        </div>

        <ConnectionFlow
          defaultMcpGatewayId={defaultMcpGateway?.id}
          defaultLlmProxyId={defaultLlmProxy?.id}
          adminDefaultMcpGatewayId={adminDefaultMcpGatewayId}
          adminDefaultLlmProxyId={adminDefaultLlmProxyId}
          adminDefaultClientId={adminDefaultClientId}
          shownClientIds={connectClients}
          shownProviders={providerCatalog.visibleIds}
          connectionBaseUrls={organization?.connectionBaseUrls ?? null}
        />
      </div>
    </div>
  );
}

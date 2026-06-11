"use client";

import { Badge } from "@/components/ui/badge";
import { useDefaultLlmProxy, useDefaultMcpGateway } from "@/lib/agent.query";
import { useOrganization } from "@/lib/organization.query";
import { ConnectSettingsDialog } from "./connect-settings-dialog";
import { ConnectionFlow } from "./connection-flow";
import { getShownProviders } from "./connection-flow.utils";
import { ConnectionHero } from "./connection-hero";

export default function ConnectionPage() {
  const { data: defaultMcpGateway } = useDefaultMcpGateway();
  const { data: defaultLlmProxy } = useDefaultLlmProxy();
  const { data: organization } = useOrganization();

  const adminDefaultMcpGatewayId =
    organization?.connectionDefaultMcpGatewayId ?? null;
  const adminDefaultLlmProxyId =
    organization?.connectionDefaultLlmProxyId ?? null;
  const adminDefaultClientId = organization?.connectionDefaultClientId ?? null;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[1680px] px-6 py-6">
        <div className="mb-7 flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <ConnectionHero />
            <Badge variant="secondary" className="mt-1 self-start">
              Beta
            </Badge>
          </div>
          <ConnectSettingsDialog />
        </div>

        <ConnectionFlow
          defaultMcpGatewayId={defaultMcpGateway?.id}
          defaultLlmProxyId={defaultLlmProxy?.id}
          adminDefaultMcpGatewayId={adminDefaultMcpGatewayId}
          adminDefaultLlmProxyId={adminDefaultLlmProxyId}
          adminDefaultClientId={adminDefaultClientId}
          shownClientIds={organization?.connectionShownClientIds ?? null}
          shownProviders={getShownProviders(organization)}
          connectionBaseUrls={organization?.connectionBaseUrls ?? null}
        />
      </div>
    </div>
  );
}

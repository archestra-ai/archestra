"use client";

import { useSearchParams } from "next/navigation";
import {
  useDefaultLlmProxy,
  useDefaultMcpGateway,
  useProfile,
} from "@/lib/agent.query";
import { useCanManageGateway } from "@/lib/auth/use-can-manage-gateway";
import { useOrganization } from "@/lib/organization.query";
import { ConnectionFlow } from "./connection-flow";
import { getShownProviders } from "./connection-flow.utils";
import { ConnectionHero } from "./connection-hero";
import { ExposedServersSummary } from "./exposed-servers-summary";

export default function ConnectionPage() {
  const { data: defaultMcpGateway } = useDefaultMcpGateway();
  const { data: defaultLlmProxy } = useDefaultLlmProxy();
  const { data: organization } = useOrganization();
  const searchParams = useSearchParams();
  const urlGatewayId = searchParams.get("gatewayId");

  const adminDefaultMcpGatewayId =
    organization?.connectionDefaultMcpGatewayId ?? null;
  const adminDefaultLlmProxyId =
    organization?.connectionDefaultLlmProxyId ?? null;
  const adminDefaultClientId = organization?.connectionDefaultClientId ?? null;
  // Mirror the fallback chain ConnectionFlow uses for the MCP gateway so the
  // Exposed Servers card reflects the same gateway the rest of the page is
  // scoped to. URL param wins so deep links render the right servers.
  const summaryGatewayId =
    urlGatewayId ?? adminDefaultMcpGatewayId ?? defaultMcpGateway?.id ?? null;
  const { data: summaryGateway } = useProfile(summaryGatewayId ?? undefined);
  const hasMcps = (summaryGateway?.tools?.length ?? 0) > 0;
  const { canManage } = useCanManageGateway(summaryGateway ?? undefined);

  return (
    <div className="mx-auto w-full max-w-[1680px] px-6 py-6">
      <div className="mb-7 flex flex-col gap-5">
        <ConnectionHero hasMcps={hasMcps} />
        {summaryGatewayId && (
          <ExposedServersSummary
            gatewayId={summaryGatewayId}
            canManage={canManage}
          />
        )}
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
  );
}

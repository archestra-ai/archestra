"use client";

import { Sparkles } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import {
  useDefaultLlmProxy,
  useDefaultMcpGateway,
  useProfile,
} from "@/lib/agent.query";
import { useCanManageGateway } from "@/lib/auth/use-can-manage-gateway";
import { useOrganization } from "@/lib/organization.query";
import { ConnectSettingsDialog } from "./connect-settings-dialog";
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
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[1680px] px-6 py-6">
        <div className="mb-7 flex flex-col gap-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <ConnectionHero hasMcps={hasMcps} />
            <div className="flex flex-wrap items-center gap-3">
              <Link
                href="/connection_beta"
                className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                <Sparkles className="size-3.5" />
                Try the new connection page
                <Badge variant="secondary">Beta</Badge>
              </Link>
              <ConnectSettingsDialog />
            </div>
          </div>
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
    </div>
  );
}

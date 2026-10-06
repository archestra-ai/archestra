"use client";

import { Settings } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { LoadingState } from "@/components/loading";
import { PageLayout } from "@/components/page-layout";
import { QueryLoadError } from "@/components/query-load-error";
import { Button } from "@/components/ui/button";
import { useDefaultMcpGateway } from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import { useLlmProxy } from "@/lib/llm-proxy.query";
import { useOrganization } from "@/lib/organization.query";
import { CONNECT_CLIENTS } from "./clients";
import { ConnectionFlow } from "./connection-flow";
import { getConnectableProviders } from "./connection-flow.utils";

export default function ConnectionPage() {
  const appName = useAppName();
  const searchParams = useSearchParams();
  const { data: canReadConnectionSettings } = useHasPermissions({
    organizationSettings: ["read"],
  });
  const isApproval = !!searchParams.get("connectRequest");
  const requestedClient = CONNECT_CLIENTS.find(
    (client) => client.id === searchParams.get("clientId"),
  );
  const approvalDocumentTitle = `Connect ${requestedClient?.label ?? "your app"}`;
  usePageTitle(isApproval ? approvalDocumentTitle : "Connect");
  const { data: defaultMcpGateway } = useDefaultMcpGateway();
  const organizationQuery = useOrganization(true, { fresh: true });
  useEffect(() => {
    // A second browser tab can change these settings without updating this
    // tab's query cache. visibilitychange is the reliable notification when
    // returning here after that tab, including embedded browser contexts.
    const refreshConnectionSettings = () => {
      if (document.visibilityState !== "visible") return;
      void organizationQuery.refetch();
    };
    document.addEventListener("visibilitychange", refreshConnectionSettings);
    return () =>
      document.removeEventListener(
        "visibilitychange",
        refreshConnectionSettings,
      );
  }, [organizationQuery.refetch]);
  // Wait for an authoritative read before mounting the flow. On later reads,
  // retain its inputs and selections but pause actions until revalidated;
  // treating a pending read as disabled would generate a partial setup.
  const organization =
    organizationQuery.isFetchedAfterMount && !organizationQuery.isError
      ? organizationQuery.data
      : undefined;
  // Fail closed until the org read confirms the Connect affordances. Missing
  // or failed reads keep skills/proxy off rather than flashing them against
  // an admin's disable setting.
  const skillsEnabled = organization?.connectionSkillsEnabled === true;
  const llmProxyEnabled = organization?.connectionLlmProxyEnabled === true;
  const pluginsEnabled = organization?.connectionPluginsEnabled === true;
  const { data: llmProxy } = useLlmProxy({ enabled: llmProxyEnabled });

  const adminDefaultMcpGatewayId =
    organization?.connectionDefaultMcpGatewayId ?? null;
  const adminDefaultClientId = organization?.connectionDefaultClientId ?? null;

  return (
    <PageLayout
      title={
        isApproval ? (
          <>
            Connect{" "}
            <span className="bg-gradient-to-r from-purple-600 to-indigo-600 bg-clip-text text-transparent">
              {requestedClient?.label ?? "your app"}
            </span>
            {` to ${appName}`}
          </>
        ) : (
          `Connect your tools to ${appName}`
        )
      }
      documentTitle={isApproval ? approvalDocumentTitle : "Connection"}
      maxWidth="wizard"
      actionButton={
        canReadConnectionSettings &&
        !isApproval && (
          <Button
            variant="outline"
            size="icon-sm"
            className="md:w-auto md:px-3"
            asChild
          >
            <Link href="/settings/connection" aria-label="Connection settings">
              <Settings aria-hidden="true" />
              <span className="hidden md:inline">Connection settings</span>
            </Link>
          </Button>
        )
      }
    >
      {(organizationQuery.isFetching && !organization) ||
      !organizationQuery.isFetchedAfterMount ? (
        <LoadingState label="Checking connection settings" />
      ) : organizationQuery.isError ? (
        <QueryLoadError
          title="Could not load connection settings"
          onRetry={() => void organizationQuery.refetch()}
        />
      ) : null}
      {organization && (
        <div aria-busy={organizationQuery.isFetching}>
          <ConnectionFlow
            isRevalidating={organizationQuery.isFetching}
            defaultMcpGatewayId={defaultMcpGateway?.id}
            llmProxyId={llmProxyEnabled ? llmProxy?.id : undefined}
            adminDefaultMcpGatewayId={adminDefaultMcpGatewayId}
            adminDefaultClientId={adminDefaultClientId}
            shownClientIds={organization.connectionShownClientIds ?? null}
            shownProviders={getConnectableProviders(organization)}
            connectionBaseUrls={organization.connectionBaseUrls ?? null}
            skillsEnabled={skillsEnabled}
            llmProxyEnabled={llmProxyEnabled}
            pluginsEnabled={pluginsEnabled}
          />
        </div>
      )}
    </PageLayout>
  );
}

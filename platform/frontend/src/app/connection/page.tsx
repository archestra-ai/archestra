"use client";

import { useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { LoadingState } from "@/components/loading";
import { PageLayout } from "@/components/page-layout";
import { QueryLoadError } from "@/components/query-load-error";
import { useDefaultMcpGateway } from "@/lib/agent.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import { useLlmProxy } from "@/lib/llm-proxy.query";
import { useOrganization } from "@/lib/organization.query";
import { CONNECT_CLIENTS } from "./clients";
import { ConnectPage } from "./connect-page";
import { ConnectionFlow } from "./connection-flow";
import { getConnectableProviders } from "./connection-flow.utils";

export default function ConnectionPage() {
  const searchParams = useSearchParams();
  // The browser approval for a connect request keeps the review flow below.
  if (searchParams.get("connectRequest")) return <ConnectionApprovalPage />;
  return <ConnectPage />;
}

function ConnectionApprovalPage() {
  const appName = useAppName();
  const searchParams = useSearchParams();
  const requestedClient = CONNECT_CLIENTS.find(
    (client) => client.id === searchParams.get("clientId"),
  );
  const approvalDocumentTitle = `Connect ${requestedClient?.label ?? "your app"}`;
  usePageTitle(approvalDocumentTitle);
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
        <>
          Connect{" "}
          <span className="bg-gradient-to-r from-purple-600 to-indigo-600 bg-clip-text text-transparent">
            {requestedClient?.label ?? "your app"}
          </span>
          {` to ${appName}`}
        </>
      }
      documentTitle={approvalDocumentTitle}
      maxWidth="wizard"
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

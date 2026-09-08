"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { LoadingState } from "@/components/loading";
import { PageLayout } from "@/components/page-layout";
import { QueryLoadError } from "@/components/query-load-error";
import { useDefaultMcpGateway } from "@/lib/agent.query";
import { useLlmProxy } from "@/lib/llm-proxy.query";
import { useOrganization } from "@/lib/organization.query";
import { CONNECT_CLIENTS } from "./clients";
import { ConnectWithAi } from "./connect-with-ai";
import { ConnectionFlow } from "./connection-flow";
import { getConnectableProviders } from "./connection-flow.utils";

export default function ConnectionPage() {
  const searchParams = useSearchParams();
  const isApproval = !!searchParams.get("connectRequest");
  const requestedClient = CONNECT_CLIENTS.find(
    (client) => client.id === searchParams.get("clientId"),
  );
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
  // retain its inputs and selections but hide the actions until revalidated;
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

  if (
    !isApproval &&
    !searchParams.get("clientId") &&
    searchParams.get("mode") !== "manual"
  ) {
    return <ConnectWithAi />;
  }

  return (
    <PageLayout
      title={
        isApproval ? (
          `Connect ${requestedClient?.label ?? "your client"}`
        ) : (
          <>
            Give Your AI{" "}
            <span className="inline-block bg-gradient-to-r from-purple-600 to-indigo-600 bg-clip-text py-1 align-baseline text-transparent">
              secure
            </span>{" "}
            access to tools
          </>
        )
      }
      actionButton={
        !isApproval ? (
          <Link
            href="/connection"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Connect with your AI
          </Link>
        ) : undefined
      }
      maxWidth="wizard"
    >
      {organizationQuery.isFetching ||
      !organizationQuery.isFetchedAfterMount ? (
        <LoadingState label="Checking connection settings" />
      ) : organizationQuery.isError ? (
        <QueryLoadError
          title="Could not load connection settings"
          onRetry={() => void organizationQuery.refetch()}
        />
      ) : null}
      {organization && (
        <div hidden={organizationQuery.isFetching}>
          <ConnectionFlow
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

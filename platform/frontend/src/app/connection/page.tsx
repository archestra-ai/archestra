"use client";

import { PageLayout } from "@/components/page-layout";
import { useDefaultMcpGateway } from "@/lib/agent.query";
import { useLlmProxy } from "@/lib/llm-proxy.query";
import { useOrganization } from "@/lib/organization.query";
import { ConnectionFlow } from "./connection-flow";
import { getConnectableProviders } from "./connection-flow.utils";

export default function ConnectionPage() {
  const { data: defaultMcpGateway } = useDefaultMcpGateway();
  const { data: llmProxy } = useLlmProxy();
  const { data: organization } = useOrganization();

  const adminDefaultMcpGatewayId =
    organization?.connectionDefaultMcpGatewayId ?? null;
  const adminDefaultClientId = organization?.connectionDefaultClientId ?? null;

  return (
    <PageLayout
      title={
        <>
          Give Your AI{" "}
          <span className="inline-block bg-gradient-to-r from-purple-600 to-indigo-600 bg-clip-text py-1 align-baseline text-transparent">
            secure
          </span>{" "}
          access to tools
        </>
      }
      maxWidth="wizard"
    >
      <ConnectionFlow
        defaultMcpGatewayId={defaultMcpGateway?.id}
        llmProxyId={llmProxy?.id}
        adminDefaultMcpGatewayId={adminDefaultMcpGatewayId}
        adminDefaultClientId={adminDefaultClientId}
        shownClientIds={organization?.connectionShownClientIds ?? null}
        shownProviders={getConnectableProviders(organization)}
        connectionBaseUrls={organization?.connectionBaseUrls ?? null}
      />
    </PageLayout>
  );
}

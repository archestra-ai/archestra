"use client";

import { isSupportedProvider, type SupportedProvider } from "@archestra/shared";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { type ReactNode, useMemo, useState } from "react";
import { AgentSelector } from "@/components/agent-selector";
import { useProfiles } from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import config from "@/lib/config/config";
import { ClientPicker } from "./client-grid";
import { CONNECT_CLIENTS } from "./clients";
import { ConnectCommandPanel, isScriptClient } from "./connect-command-panel";
import { ConnectConfigPanel, isConfigClient } from "./connect-config-panel";
import {
  type ConnectionBaseUrl,
  resolveAdminDefaultBaseUrl,
  resolveCandidateBaseUrls,
  resolveEffectiveId,
  resolveInitialClientId,
} from "./connection-flow.utils";
import { ConnectionUrlStep } from "./connection-url-step";
import { McpClientInstructions } from "./mcp-client-instructions";
import { ProxyClientInstructions } from "./proxy-client-instructions";
import {
  SkillsMarketplaceStep,
  useSkillsMarketplaceVisible,
} from "./skills-marketplace-step";
import { useUpdateUrlParams } from "./use-update-url-params";
import { WizardStep } from "./wizard-step";

interface ConnectionFlowProps {
  defaultMcpGatewayId?: string;
  defaultLlmProxyId?: string;
  adminDefaultMcpGatewayId?: string | null;
  adminDefaultLlmProxyId?: string | null;
  adminDefaultClientId?: string | null;
  /** When null/undefined: show all. Otherwise: only these IDs (plus "generic" always). */
  shownClientIds?: readonly string[] | null;
  /** When null/undefined: show all. Otherwise: only these providers. */
  shownProviders?: readonly SupportedProvider[] | null;
  /** Admin-curated descriptions and default flag for env-configured base URLs. */
  connectionBaseUrls?: readonly ConnectionBaseUrl[] | null;
}

export function ConnectionFlow({
  defaultMcpGatewayId,
  defaultLlmProxyId,
  adminDefaultMcpGatewayId,
  adminDefaultLlmProxyId,
  adminDefaultClientId,
  shownClientIds,
  shownProviders,
  connectionBaseUrls,
}: ConnectionFlowProps) {
  const searchParams = useSearchParams();
  const urlGatewayId = searchParams.get("gatewayId");
  const urlProxyId = searchParams.get("proxyId");
  const urlClientId = searchParams.get("clientId");
  const fromTable = searchParams.get("from") === "table";

  const updateUrlParams = useUpdateUrlParams();

  const { data: mcpGateways } = useProfiles({
    filters: {
      agentTypes: ["profile", "mcp_gateway"],
      excludeOtherPersonalAgents: true,
    },
  });
  const { data: llmProxies } = useProfiles({
    filters: {
      agentTypes: ["profile", "llm_proxy"],
      excludeOtherPersonalAgents: true,
    },
  });

  const { data: canReadMcpGateway } = useHasPermissions({
    mcpGateway: ["read"],
  });
  const { data: canReadLlmProxy } = useHasPermissions({ llmProxy: ["read"] });

  const visibleClients = useMemo(() => {
    if (!shownClientIds) return CONNECT_CLIENTS;
    const shown = new Set(shownClientIds);
    // "generic" ("Any client") is always visible regardless of admin config.
    return CONNECT_CLIENTS.filter((c) => c.id === "generic" || shown.has(c.id));
  }, [shownClientIds]);

  // Pre-select a client so the flow never loads blank. URL param wins (for
  // bookmarkable state), then the admin default, then the first visible
  // client as the system fallback.
  const initialClientId = resolveInitialClientId({
    urlClientId,
    adminDefaultClientId,
    visibleClientIds: visibleClients.map((c) => c.id),
  });
  const [clientId, setClientId] = useState<string | null>(initialClientId);
  const client = visibleClients.find((c) => c.id === clientId) ?? null;

  const selectClient = (id: string) => {
    setClientId(id);
    // Providers vary per client, so clear any bookmarked provider on switch.
    updateUrlParams({ clientId: id, providerId: null });
  };

  const [selectedMcpId, setSelectedMcpId] = useState<string | null>(null);
  const [selectedProxyId, setSelectedProxyId] = useState<string | null>(null);

  // Connection base URL — chosen once for the whole page, threaded into each
  // instruction panel below. Admins can hide individual env URLs from end
  // users; we filter those out here. Falls back to the admin default, then the
  // first remaining env URL, then the in-cluster internal URL.
  const candidateBaseUrls = useMemo(
    () =>
      resolveCandidateBaseUrls({
        externalProxyUrls: config.api.externalProxyUrls,
        internalProxyUrl: config.api.internalProxyUrl,
        metadata: connectionBaseUrls,
      }),
    [connectionBaseUrls],
  );
  const adminDefaultBaseUrl = useMemo(
    () => resolveAdminDefaultBaseUrl(connectionBaseUrls),
    [connectionBaseUrls],
  );
  // Derived, not stateful: this lets the admin default take effect after the
  // org data resolves on initial load. Once the user manually picks a URL,
  // `userBaseUrl` overrides every fallback below.
  const [userBaseUrl, setUserBaseUrl] = useState<string | null>(null);
  const baseUrl =
    (userBaseUrl && candidateBaseUrls.includes(userBaseUrl) && userBaseUrl) ||
    (adminDefaultBaseUrl &&
      candidateBaseUrls.includes(adminDefaultBaseUrl) &&
      adminDefaultBaseUrl) ||
    candidateBaseUrls[0];

  const handleMcpSelect = (id: string) => {
    setSelectedMcpId(id);
    updateUrlParams({ gatewayId: id });
  };
  const handleProxySelect = (id: string) => {
    setSelectedProxyId(id);
    updateUrlParams({ proxyId: id });
  };

  // When arriving from the opposite slot's table (only that slot's ID is
  // pinned in the URL), skip this slot's admin default so it doesn't override
  // the user's intent — fall through to the system default instead.
  const effectiveMcpId = resolveEffectiveId({
    selected: selectedMcpId,
    fromUrl: urlGatewayId,
    adminDefault: adminDefaultMcpGatewayId,
    systemDefault: defaultMcpGatewayId,
    firstAvailable: mcpGateways?.[0]?.id,
    skipAdminDefault: fromTable && !!urlProxyId && !urlGatewayId,
  });

  const effectiveProxyId = resolveEffectiveId({
    selected: selectedProxyId,
    fromUrl: urlProxyId,
    adminDefault: adminDefaultLlmProxyId,
    systemDefault: defaultLlmProxyId,
    firstAvailable: llmProxies?.[0]?.id,
    skipAdminDefault: fromTable && !!urlGatewayId && !urlProxyId,
  });

  const selectedMcp = mcpGateways?.find((g) => g.id === effectiveMcpId);
  const selectedProxy = llmProxies?.find((p) => p.id === effectiveProxyId);

  const urlProviderId = searchParams.get("providerId");
  const urlProvider: SupportedProvider | null =
    urlProviderId && isSupportedProvider(urlProviderId) ? urlProviderId : null;

  const skillsVisible = useSkillsMarketplaceVisible(client);

  // Manual flow (n8n / Any client): one wizard-rail entry per instruction
  // block, numbered after the client step.
  const manualClient =
    client && !isScriptClient(client.id) && !isConfigClient(client.id)
      ? client
      : null;
  const manualSteps: {
    key: string;
    title: string;
    actions?: ReactNode;
    content: ReactNode;
  }[] = [];
  if (manualClient) {
    if (candidateBaseUrls.length > 1) {
      manualSteps.push({
        key: "endpoint",
        title: "Select an endpoint",
        content: (
          <ConnectionUrlStep
            bare
            candidateUrls={candidateBaseUrls}
            metadata={connectionBaseUrls}
            value={baseUrl}
            onChange={setUserBaseUrl}
          />
        ),
      });
    }
    if (canReadMcpGateway) {
      manualSteps.push({
        key: "mcp",
        title: "Connect the MCP Gateway to access tools",
        actions:
          manualClient.mcp.kind !== "unsupported" &&
          (mcpGateways?.length ?? 0) > 1 ? (
            <AgentSelector
              mode="single"
              flat
              className="w-64"
              agents={mcpGateways ?? []}
              value={effectiveMcpId ?? ""}
              onValueChange={handleMcpSelect}
              placeholder="Select gateway"
              searchPlaceholder="Search gateways…"
            />
          ) : undefined,
        content:
          selectedMcp && effectiveMcpId ? (
            <McpClientInstructions
              client={manualClient}
              gatewayId={effectiveMcpId}
              gatewaySlug={selectedMcp.slug ?? effectiveMcpId}
              gatewayName={selectedMcp.name}
              baseUrl={baseUrl}
            />
          ) : (
            <NoAgentsPanel kind="MCP gateways" href="/mcp/gateways" />
          ),
      });
    }
    if (canReadLlmProxy) {
      manualSteps.push({
        key: "proxy",
        title: "Route through the LLM Proxy to make it secure",
        actions:
          manualClient.proxy.kind !== "unsupported" &&
          (llmProxies?.length ?? 0) > 1 ? (
            <AgentSelector
              mode="single"
              flat
              className="w-64"
              agents={llmProxies ?? []}
              value={effectiveProxyId ?? ""}
              onValueChange={handleProxySelect}
              placeholder="Select proxy"
              searchPlaceholder="Search proxies…"
            />
          ) : undefined,
        content: effectiveProxyId ? (
          <ProxyClientInstructions
            client={manualClient}
            profileId={effectiveProxyId}
            profileName={selectedProxy?.name ?? ""}
            shownProviders={shownProviders}
            baseUrl={baseUrl}
          />
        ) : (
          <NoAgentsPanel kind="LLM proxies" href="/llm/proxies" />
        ),
      });
    }
    if (skillsVisible) {
      manualSteps.push({
        key: "skills",
        title: "Install shared skills",
        content: <SkillsMarketplaceStep client={manualClient} />,
      });
    }
  }

  return (
    <div className="flex max-w-5xl flex-col">
      {/* Step 1 — Client */}
      <WizardStep n={1} title="Select your client" last={!client}>
        <ClientPicker
          clients={visibleClients}
          selected={clientId}
          onSelect={selectClient}
        />
      </WizardStep>

      {/* Steps 2-3 (script clients) — review, then run the command */}
      {client && isScriptClient(client.id) && (
        <ConnectCommandPanel
          client={client}
          mcpGateways={canReadMcpGateway ? (mcpGateways ?? []) : null}
          mcpGatewayId={effectiveMcpId}
          onMcpGatewaySelect={handleMcpSelect}
          llmProxies={canReadLlmProxy ? (llmProxies ?? []) : null}
          llmProxyId={effectiveProxyId}
          onLlmProxySelect={handleProxySelect}
          shownProviders={shownProviders}
          urlProvider={urlProvider}
          onProviderSelect={(p) => updateUrlParams({ providerId: p })}
          baseUrl={baseUrl}
          candidateBaseUrls={candidateBaseUrls}
          baseUrlMetadata={connectionBaseUrls}
          onBaseUrlChange={setUserBaseUrl}
        />
      )}

      {/* Steps 2-4 (Claude Desktop) — review, download a config profile, import */}
      {client && isConfigClient(client.id) && (
        <ConnectConfigPanel
          mcpGateways={canReadMcpGateway ? (mcpGateways ?? []) : null}
          mcpGatewayId={effectiveMcpId}
          onMcpGatewaySelect={handleMcpSelect}
          gatewaySlug={selectedMcp?.slug ?? effectiveMcpId}
          llmProxies={canReadLlmProxy ? (llmProxies ?? []) : null}
          llmProxyId={effectiveProxyId}
          onLlmProxySelect={handleProxySelect}
          baseUrl={baseUrl}
          candidateBaseUrls={candidateBaseUrls}
          baseUrlMetadata={connectionBaseUrls}
          onBaseUrlChange={setUserBaseUrl}
        />
      )}

      {/* Steps 2..n (n8n / Any client) — manual instructions on the rail */}
      {manualSteps.map((s, i) => (
        <WizardStep
          key={s.key}
          n={i + 2}
          title={s.title}
          actions={s.actions}
          last={i === manualSteps.length - 1}
        >
          {s.content}
        </WizardStep>
      ))}
    </div>
  );
}

// ===================================================================
// Internal pieces
// ===================================================================

function NoAgentsPanel({ kind, href }: { kind: string; href: string }) {
  return (
    <div className="rounded-lg border border-dashed bg-muted/30 p-6 text-center text-sm text-muted-foreground">
      No {kind} available.{" "}
      <Link href={href} className="underline hover:text-foreground">
        Create one
      </Link>{" "}
      to continue.
    </div>
  );
}

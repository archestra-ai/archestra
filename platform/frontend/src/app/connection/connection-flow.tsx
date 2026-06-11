"use client";

import { isSupportedProvider, type SupportedProvider } from "@archestra/shared";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useProfiles } from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import config from "@/lib/config/config";
import { ClientPicker } from "./client-grid";
import { CONNECT_CLIENTS } from "./clients";
import {
  ConnectCommandStep,
  type ConnectProxyAuth,
  isScriptClient,
} from "./connect-command-step";
import { ConnectSkillsStep } from "./connect-skills-step";
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
import { SearchableSelect } from "./searchable-select";
import { SkillsMarketplaceStep } from "./skills-marketplace-step";
import { StepCard, type StepState } from "./step-card";
import { useUpdateUrlParams } from "./use-update-url-params";

type OpenKey = "client" | "mcp" | "proxy" | "skills" | "connect";

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
  const from = searchParams.get("from");
  const fromTable = from === "table";

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
  // bookmarkable state), then the admin default, then "Any Client" as the
  // system fallback.
  const initialClientId = resolveInitialClientId({
    urlClientId,
    adminDefaultClientId,
    visibleClientIds: visibleClients.map((c) => c.id),
  });
  const [clientId, setClientId] = useState<string | null>(initialClientId);
  const client = visibleClients.find((c) => c.id === clientId) ?? null;

  const [openSteps, setOpenSteps] = useState<Set<OpenKey>>(() => {
    const initial = new Set<OpenKey>(["client"]);
    if (initialClientId) {
      // Mirror selectClient's auto-open logic for bookmarked URLs.
      if (fromTable && urlGatewayId && !urlProxyId) initial.add("mcp");
      else if (fromTable && urlProxyId && !urlGatewayId) initial.add("proxy");
      else {
        initial.add("mcp");
        initial.add("proxy");
        initial.add("skills");
      }
      initial.add("connect");
    }
    return initial;
  });
  const isOpen = (k: OpenKey) => openSteps.has(k);
  const toggleOne = (k: OpenKey) =>
    setOpenSteps((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  const selectClient = (id: string | null) => {
    setClientId(id);
    // Providers vary per client, so clear any bookmarked provider on switch.
    updateUrlParams({ clientId: id, providerId: null });
    if (!id) return;
    // When the user arrived from the MCP Gateway / LLM Proxy table
    // (from=table + only one pinned id), auto-open just that side.
    // Otherwise expand both steps so the full flow is visible.
    const toOpen: OpenKey[] =
      fromTable && urlGatewayId && !urlProxyId
        ? ["mcp", "connect"]
        : fromTable && urlProxyId && !urlGatewayId
          ? ["proxy", "connect"]
          : ["mcp", "proxy", "skills", "connect"];
    setOpenSteps((s) => new Set<OpenKey>([...s, ...toOpen]));
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

  // Script-capable clients get selection-only steps plus a final card that
  // turns the selections into one `curl | bash` command.
  const scriptClient = clientId !== null && isScriptClient(clientId);
  // Passthrough by default: the script rewires the base URL and the user
  // keeps their own provider credentials. "virtual-key" auto-provisions one.
  const [proxyAuth, setProxyAuth] = useState<ConnectProxyAuth>("provider-key");
  const [includeSkills, setIncludeSkills] = useState(false);
  const urlProviderId = searchParams.get("providerId");
  const selectedProvider: SupportedProvider | null =
    urlProviderId && isSupportedProvider(urlProviderId) ? urlProviderId : null;

  const mcpState: StepState = !clientId
    ? "todo"
    : isOpen("mcp")
      ? "active"
      : "todo";
  const proxyState: StepState = !clientId
    ? "todo"
    : isOpen("proxy")
      ? "active"
      : "todo";

  return (
    <div className="grid gap-3.5">
      {/* Step 1 — Client */}
      <ClientPicker
        clients={visibleClients}
        selected={clientId}
        onSelect={selectClient}
      />

      {/* Connection URL — picked once, reused by every snippet below. */}
      <ConnectionUrlStep
        candidateUrls={candidateBaseUrls}
        metadata={connectionBaseUrls}
        value={baseUrl}
        onChange={setUserBaseUrl}
        disabled={!clientId}
      />

      {/* Step 2 — MCP Gateway */}
      {canReadMcpGateway && (
        <StepCard
          hideStatus
          title="Connect the MCP Gateway to access tools"
          state={mcpState}
          expanded={isOpen("mcp") && !!client}
          onToggle={client ? () => toggleOne("mcp") : undefined}
          actions={
            client &&
            isOpen("mcp") &&
            client.mcp.kind !== "unsupported" &&
            (mcpGateways?.length ?? 0) > 1 ? (
              <SearchableSelect
                options={(mcpGateways ?? []).map((g) => ({
                  value: g.id,
                  label: g.name,
                }))}
                value={effectiveMcpId}
                onValueChange={handleMcpSelect}
                placeholder="Select gateway"
              />
            ) : null
          }
        >
          {client && selectedMcp && effectiveMcpId && scriptClient && (
            <div className="rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground">
              The setup command registers{" "}
              <span className="font-medium text-foreground">
                {selectedMcp.name}
              </span>{" "}
              in {client.label} with OAuth — no tokens to copy. Generate the
              command in the last step.
            </div>
          )}
          {client && selectedMcp && effectiveMcpId && !scriptClient && (
            <McpClientInstructions
              client={client}
              gatewayId={effectiveMcpId}
              gatewaySlug={selectedMcp.slug ?? effectiveMcpId}
              gatewayName={selectedMcp.name}
              baseUrl={baseUrl}
            />
          )}
          {client && !effectiveMcpId && (
            <div className="rounded-lg border border-dashed bg-muted/30 p-6 text-center text-sm text-muted-foreground">
              No MCP gateways available.{" "}
              <Link
                href="/mcp/gateways"
                className="underline hover:text-foreground"
              >
                Create one
              </Link>{" "}
              to continue.
            </div>
          )}
        </StepCard>
      )}

      {/* Step 3 — LLM Proxy */}
      {canReadLlmProxy && (
        <StepCard
          hideStatus
          title="Route through the LLM Proxy to make it secure"
          state={proxyState}
          expanded={isOpen("proxy") && !!client}
          onToggle={client ? () => toggleOne("proxy") : undefined}
          actions={
            client &&
            isOpen("proxy") &&
            client.proxy.kind !== "unsupported" &&
            (llmProxies?.length ?? 0) > 1 ? (
              <SearchableSelect
                options={(llmProxies ?? []).map((p) => ({
                  value: p.id,
                  label: p.name,
                }))}
                value={effectiveProxyId}
                onValueChange={handleProxySelect}
                placeholder="Select proxy"
              />
            ) : null
          }
        >
          {client && effectiveProxyId && (
            <div className="space-y-3">
              {scriptClient && (
                <div className="space-y-2">
                  <Tabs
                    value={proxyAuth}
                    onValueChange={(v) => setProxyAuth(v as ConnectProxyAuth)}
                  >
                    <TabsList className="w-full">
                      <TabsTrigger value="provider-key" className="flex-1">
                        Your provider key
                      </TabsTrigger>
                      <TabsTrigger value="virtual-key" className="flex-1">
                        Virtual key
                      </TabsTrigger>
                    </TabsList>
                  </Tabs>
                  <p className="text-sm text-muted-foreground">
                    {proxyAuth === "provider-key"
                      ? "Pick the provider to route through the proxy — the setup command rewires the base URL and you keep using your own API key or login."
                      : "Pick the provider to route through the proxy — the setup command wires it up with a virtual key created for you."}
                  </p>
                </div>
              )}
              <ProxyClientInstructions
                client={client}
                profileId={effectiveProxyId}
                profileName={selectedProxy?.name ?? ""}
                shownProviders={shownProviders}
                baseUrl={baseUrl}
                selectionOnly={scriptClient}
              />
            </div>
          )}
          {client && !effectiveProxyId && (
            <div className="rounded-lg border border-dashed bg-muted/30 p-6 text-center text-sm text-muted-foreground">
              No LLM proxies available.{" "}
              <Link
                href="/llm/proxies"
                className="underline hover:text-foreground"
              >
                Create one
              </Link>{" "}
              to continue.
            </div>
          )}
        </StepCard>
      )}

      {/* Step 4 — Skills. Non-script clients get the marketplace link UI;
          script clients get a checkbox that folds skills into the command. */}
      {!scriptClient && (
        <SkillsMarketplaceStep
          client={client}
          expanded={isOpen("skills")}
          onToggle={client ? () => toggleOne("skills") : undefined}
        />
      )}
      {scriptClient && client && (
        <ConnectSkillsStep
          includeSkills={includeSkills}
          onIncludeChange={setIncludeSkills}
          expanded={isOpen("skills")}
          onToggle={() => toggleOne("skills")}
        />
      )}

      {/* Final step — one command that connects everything (script clients) */}
      {scriptClient && client && (
        <ConnectCommandStep
          client={client}
          baseUrl={baseUrl}
          mcpGateway={
            canReadMcpGateway && selectedMcp && effectiveMcpId
              ? { id: effectiveMcpId, name: selectedMcp.name }
              : null
          }
          llmProxy={
            canReadLlmProxy &&
            selectedProxy &&
            effectiveProxyId &&
            selectedProvider
              ? {
                  id: effectiveProxyId,
                  name: selectedProxy.name,
                  provider: selectedProvider,
                }
              : null
          }
          proxyAuth={proxyAuth}
          proxyNeedsProvider={
            !!(
              canReadLlmProxy &&
              selectedProxy &&
              effectiveProxyId &&
              !selectedProvider
            )
          }
          includeSkills={includeSkills}
          expanded={isOpen("connect")}
          onToggle={() => toggleOne("connect")}
        />
      )}
    </div>
  );
}

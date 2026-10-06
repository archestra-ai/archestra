"use client";

// Data for the Connect page. Real data where the app has it (gateway,
// servers, tools, skills, apps, admin settings); clearly marked mocks where
// the backend has nothing yet (context cost, guardrails status).

import { archestraApiSdk, type SupportedProvider } from "@archestra/shared";
import {
  buildConnectionPrompt,
  CONNECT_SETUP_PARTS,
  INSTALLER_CLIENT_FOOTPRINT,
  INSTALLER_CLIENT_IDS,
} from "@archestra/shared/connection-setup";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type { AgentSelectorAgent } from "@/components/agent-selector";
import { useDefaultMcpGateway, useProfile } from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import config from "@/lib/config/config";
import { useConfig } from "@/lib/config/config.query";
import {
  type ConnectedClient,
  useConnectedClients,
} from "@/lib/connected-client.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useLlmProxy } from "@/lib/llm-proxy.query";
import {
  groupCatalogTools,
  useAllCatalogTools,
  useInternalMcpCatalog,
} from "@/lib/mcp/internal-mcp-catalog.query";
import { useOrganization } from "@/lib/organization.query";
import { usePlugins } from "@/lib/plugins/plugin.query";
import {
  CONNECT_CLIENTS,
  type ConnectClient,
  usesGenericInstructions,
} from "./clients";
import type { ConnectChoices } from "./connect-choices";
import {
  type ConnectionBaseUrl,
  getConnectableProviders,
  resolveAdminDefaultBaseUrl,
  resolveCandidateBaseUrls,
} from "./connection-flow.utils";

export interface ConnectServer {
  key: string;
  catalogId: string | null;
  name: string;
  /** Catalog icon; render with <McpCatalogIcon icon={...} catalogId={...} />. */
  icon: string | null;
  toolCount: number;
  tools: { name: string; description: string | null }[];
}

export interface ConnectPageSkill {
  id: string;
  name: string;
  description: string;
  scope: "personal" | "team" | "org";
  usageCount: number;
}

/** An agent this user connected (a redeemed setup), newest first. */
export interface ConnectedAgent {
  clientId: ConnectedClient["clientId"];
  client: ConnectClient;
  /** Latest connect for this agent; changes when another machine connects. */
  lastConnectedAt: ConnectedClient["lastConnectedAt"];
  /** Machines this agent is connected on, most recent first; may be empty. */
  deviceNames: ConnectedClient["deviceNames"];
}

/** What the setup adds to one agent, which disconnect.md removes. */
export interface ConnectFootprint {
  skillsInstalled: number;
  /** Files/entries the setup changed on the user's machine. */
  localChanges: string[];
}

export interface ConnectPlugin {
  id: string;
  name: string;
  description: string | null;
}

/** A gateway the user can connect through. */
export type ConnectGateway = AgentSelectorAgent & { slug: string };

export interface ConnectPageData {
  loading: boolean;
  /**
   * A fresh read of the connection settings is in flight (after returning to
   * the tab): keep the page, but hold actions until it lands.
   */
  revalidating: boolean;
  /** Every app the admin shows on the page ("generic" = Any client, always last). */
  clients: ConnectClient[];
  /** The handful of apps with first-class setup, for hero rows and pickers. */
  featuredClients: ConnectClient[];
  /** The app the admin picks first, when set. */
  defaultClientId: string | null;
  /** The instance's configured name ("Archestra" unless white-labeled). */
  appName: string;
  gateway: ConnectGateway | null;
  /** Endpoints the admin offers; more than one shows a picker. */
  baseUrls: readonly string[];
  baseUrlMetadata: readonly ConnectionBaseUrl[] | null;
  baseUrl: string;
  selectBaseUrl: (url: string) => void;
  servers: ConnectServer[];
  totalTools: number;
  /** True when the gateway exposes every server in the org, incl. new ones. */
  allServers: boolean;
  skills: ConnectPageSkill[];
  totalSkills: number;
  /** Gateway "progressive tool loading": tools load on demand. */
  progressive: boolean;
  llmProxyEnabled: boolean;
  /** The org's LLM Proxy, when the user can route through it. */
  llmProxyId: string | null;
  /** Model providers the admin offers for routing. */
  shownProviders: SupportedProvider[];
  skillsEnabled: boolean;
  pluginsEnabled: boolean;
  /** Approved plugins the setup bundles for this client. */
  pluginsFor: (client: ConnectClient) => ConnectPlugin[];
  /** Setup parts this client can get; the rest never show as choices. */
  partsFor: (client: ConnectClient) => ConnectChoices;
  /** MOCK: whether OpenAPPA guardrails watch connected agents. */
  guardrails: { enabled: boolean; name: string };
  /** Can open /settings/connection (admin). */
  canManage: boolean;
  /** Agents this user connected; empty while loading or on error. */
  connected: ConnectedAgent[];
  /** Re-reads the connected agents, e.g. while waiting for an approval. */
  refetchConnected: () => void;
  /** What connecting this client would create / disconnecting would remove. */
  footprintFor: (client: ConnectClient) => ConnectFootprint;
  /**
   * The connect prompt, carrying what the user left out: `exclude=` for apps
   * with an installer, the setup/gateway/base params for other agents. null
   * when nothing is left to set up.
   */
  connectPrompt: (
    client: ConnectClient,
    choices: ConnectChoices,
  ) => string | null;
  /** The cleanup prompt: disconnect.md removes what connect.md set up. */
  disconnectPrompt: (client: ConnectClient) => string;
  /**
   * The terminal command that runs the public installer for an app with one
   * (the same installer the prompt has the agent run), carrying what the user
   * left out. PowerShell on Windows, a POSIX shell elsewhere.
   */
  installerCommand: (
    client: ConnectClient,
    choices: ConnectChoices,
    windows: boolean,
  ) => string;
}

/** What connect.md?client=generic can set up; it has no plugins. */
const GENERIC_PARTS = ["tools", "skills", "proxy"] as const;

/** What a setup leaves on the machine, per app (n8n has no installer). */
const LOCAL_CHANGES: Record<string, string[]> = {
  ...INSTALLER_CLIENT_FOOTPRINT,
  n8n: ["The MCP Client Tool node you added in n8n"],
};

export function useConnectPageData(): ConnectPageData {
  // A fresh read: these settings decide what a setup may include.
  const orgQuery = useOrganization(true, { fresh: true });
  const { data: org, isPending: orgPending } = orgQuery;
  const refetchOrg = orgQuery.refetch;
  useEffect(() => {
    // Another tab can change these settings without touching this tab's
    // cache; coming back to this tab is the reliable signal to re-read them.
    const refresh = () => {
      if (document.visibilityState === "visible") void refetchOrg();
    };
    document.addEventListener("visibilitychange", refresh);
    return () => document.removeEventListener("visibilitychange", refresh);
  }, [refetchOrg]);

  const { data: canReadGateways } = useHasPermissions({
    mcpGateway: ["read"],
  });
  const { data: canReadLlmProxy } = useHasPermissions({ llmProxy: ["read"] });
  const { data: canReadSkills } = useHasPermissions({ skill: ["read"] });
  const { data: canDeliverPlugins } = useHasPermissions(
    { plugin: ["read", "update"] },
    "*",
  );
  const { data: appConfig } = useConfig();

  const { data: defaultGateway } = useDefaultMcpGateway();
  const gatewayId = org?.connectionDefaultMcpGatewayId ?? defaultGateway?.id;
  const { data: profile, isPending: profilePending } = useProfile(gatewayId);
  const { data: catalog } = useInternalMcpCatalog();
  const accessAll = profile?.accessAllTools ?? false;
  const { data: catalogTools } = useAllCatalogTools({ enabled: accessAll });
  const { data: canManage } = useHasPermissions({
    organizationSettings: ["read"],
  });
  const skillsEnabled = org?.connectionSkillsEnabled === true;
  const { data: skillList } = useQuery({
    queryKey: ["connect-page", "skills"],
    enabled: skillsEnabled && canReadSkills === true,
    queryFn: fetchAllSkills,
  });

  const llmProxyEnabled = org?.connectionLlmProxyEnabled === true;
  const { data: llmProxy } = useLlmProxy({ enabled: llmProxyEnabled });
  const proxyAvailable =
    llmProxyEnabled && canReadLlmProxy === true && !!llmProxy?.id;

  const pluginsEnabled = org?.connectionPluginsEnabled === true;
  // Same eligibility and filter the setup uses to bundle plugins.
  const { data: allPlugins } = usePlugins(
    pluginsEnabled &&
      appConfig?.features.plugins === true &&
      canDeliverPlugins === true,
  );
  const pluginsFor = (client: ConnectClient): ConnectPlugin[] =>
    (allPlugins ?? [])
      .filter(
        (p) =>
          p.clientType === client.id &&
          p.enabled &&
          p.approvedContentHash === p.contentHash,
      )
      .map((p) => ({
        id: p.id,
        name: p.displayName,
        description: p.description,
      }));

  const baseUrls = useMemo(
    () =>
      resolveCandidateBaseUrls({
        externalProxyUrls: config.api.externalProxyUrls,
        internalProxyUrl: config.api.internalProxyUrl,
        metadata: org?.connectionBaseUrls ?? null,
      }),
    [org?.connectionBaseUrls],
  );
  const adminBaseUrl = resolveAdminDefaultBaseUrl(
    org?.connectionBaseUrls ?? null,
  );
  const [pickedBaseUrl, setPickedBaseUrl] = useState<string | null>(null);
  const baseUrl =
    (pickedBaseUrl && baseUrls.includes(pickedBaseUrl) && pickedBaseUrl) ||
    (adminBaseUrl && baseUrls.includes(adminBaseUrl) && adminBaseUrl) ||
    baseUrls[0];

  const clients = useMemo(() => {
    const shown = org?.connectionShownClientIds;
    if (!shown) return CONNECT_CLIENTS;
    const set = new Set(shown);
    return CONNECT_CLIENTS.filter((c) => c.id === "generic" || set.has(c.id));
  }, [org?.connectionShownClientIds]);
  const featuredClients = INSTALLER_CLIENT_IDS.map((id) =>
    clients.find((c) => c.id === id),
  ).filter((c): c is ConnectClient => !!c);

  const servers = useMemo<ConnectServer[]>(() => {
    const byId = new Map((catalog ?? []).map((c) => [c.id, c]));
    if (accessAll) {
      const toolsByCatalog = groupCatalogTools(catalogTools);
      return (catalog ?? [])
        .map((c) => ({
          key: c.id,
          catalogId: c.id,
          name: c.name,
          icon: c.icon,
          toolCount: c.toolCount,
          tools: (toolsByCatalog.get(c.id) ?? []).map((t) => ({
            name: shortToolName(t.name),
            description: null,
          })),
        }))
        .sort((a, b) => b.toolCount - a.toolCount);
    }
    const groups = new Map<string | null, ConnectServer["tools"]>();
    for (const t of profile?.tools ?? []) {
      const list = groups.get(t.catalogId) ?? [];
      list.push({ name: shortToolName(t.name), description: t.description });
      groups.set(t.catalogId, list);
    }
    return [...groups.entries()]
      .map(([catalogId, tools]) => {
        const item = catalogId ? byId.get(catalogId) : undefined;
        return {
          key: catalogId ?? "other",
          catalogId,
          name: item?.name ?? "Other",
          icon: item?.icon ?? null,
          toolCount: tools.length,
          tools,
        };
      })
      .sort((a, b) => b.toolCount - a.toolCount);
  }, [accessAll, profile?.tools, catalog, catalogTools]);
  const totalTools = servers.reduce((n, s) => n + s.toolCount, 0);
  const progressive = profile?.toolExposureMode === "search_and_run_only";

  const skills = skillList ?? [];
  const skillsAvailable = skillsEnabled && skills.length > 0;
  const gateway = profile
    ? { ...profile, slug: profile.slug ?? profile.id }
    : null;
  const toolsAvailable = canReadGateways === true && !!gateway;
  const partsFor = (client: ConnectClient): ConnectChoices => ({
    tools: toolsAvailable,
    skills: skillsAvailable,
    proxy: proxyAvailable && client.proxy.kind !== "unsupported",
    // Plugins come with the installer; other agents set themselves up.
    plugins: !usesGenericInstructions(client) && pluginsFor(client).length > 0,
  });

  // A failed read just shows nothing connected.
  const connectedQuery = useConnectedClients();
  const appName = useAppName();

  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);

  const footprint = (client: ConnectClient): ConnectFootprint => ({
    skillsInstalled: skillsEnabled ? skills.length : 0,
    localChanges: LOCAL_CHANGES[client.id] ?? [
      "The Archestra MCP entry in your agent's config",
    ],
  });

  return {
    loading: orgPending || (!!gatewayId && profilePending),
    revalidating: orgQuery.isFetching,
    clients,
    featuredClients,
    defaultClientId: org?.connectionDefaultClientId ?? null,
    appName,
    gateway,
    baseUrls,
    baseUrlMetadata: org?.connectionBaseUrls ?? null,
    baseUrl,
    selectBaseUrl: setPickedBaseUrl,
    servers,
    totalTools,
    allServers: accessAll,
    skills,
    totalSkills: skills.length,
    progressive,
    llmProxyEnabled: proxyAvailable,
    llmProxyId: proxyAvailable ? (llmProxy?.id ?? null) : null,
    shownProviders: getConnectableProviders(org),
    skillsEnabled,
    pluginsEnabled,
    pluginsFor,
    partsFor,
    guardrails: { enabled: true, name: "OpenAPPA" },
    canManage: canManage === true,
    connected: (connectedQuery.data ?? []).flatMap(
      ({ clientId, lastConnectedAt, deviceNames }) => {
        const client = CONNECT_CLIENTS.find((c) => c.id === clientId);
        return client
          ? [{ clientId, client, lastConnectedAt, deviceNames }]
          : [];
      },
    ),
    refetchConnected: () => void connectedQuery.refetch(),
    footprintFor: (client) => footprint(client),
    connectPrompt: (client, choices) => {
      const parts = partsFor(client);
      const on = (part: keyof ConnectChoices) => parts[part] && choices[part];
      if (!usesGenericInstructions(client)) {
        return buildConnectionPrompt({
          origin,
          clientId: client.id,
          label: client.label,
          exclude: CONNECT_SETUP_PARTS.filter((part) => !choices[part]),
        });
      }
      // Other agents: connect.md?client=generic checks what the app supports
      // and reads what to leave out from these params (no plugins there).
      const exclude = GENERIC_PARTS.filter((part) => !on(part));
      if (exclude.length === GENERIC_PARTS.length) return null;
      const params = new URLSearchParams({ client: "generic" });
      if (gateway && on("tools")) params.set("gateway", gateway.slug);
      if (exclude.length > 0) params.set("exclude", exclude.join(","));
      // connect.md falls back to this page's own origin.
      if (baseUrl !== `${origin}/v1`) params.set("base", baseUrl);
      return `Read ${origin}/connect.md?${decodeURIComponent(params.toString())} and connect ${client.label}.`;
    },
    installerCommand: (client, choices, windows) => {
      const exclude = CONNECT_SETUP_PARTS.filter((part) => !choices[part]);
      const excludeFlag = exclude.length
        ? ` --exclude ${exclude.join(",")}`
        : "";
      const fetch = windows ? "irm" : "curl -fsSL";
      return `${fetch} ${origin}/api/client-connections/installer | node - --url ${origin} --client ${client.id}${excludeFlag}`;
    },
    disconnectPrompt: (client) => {
      // Same split as connectPrompt: apps with an installer get their own
      // steps; other agents get the generic ones. Both point at the base the
      // setup wrote, when it isn't this page's own.
      const params = new URLSearchParams({
        client: usesGenericInstructions(client) ? "generic" : client.id,
      });
      if (baseUrl !== `${origin}/v1`) params.set("base", baseUrl);
      return `Read ${origin}/disconnect.md?${decodeURIComponent(params.toString())} and disconnect ${client.label} from ${appName}.`;
    },
  };
}

/** Every skill, a page at a time: the card and lists show the real total. */
async function fetchAllSkills(): Promise<ConnectPageSkill[]> {
  const skills: ConnectPageSkill[] = [];
  const limit = 100;
  for (let offset = 0; ; offset += limit) {
    const { data } = await archestraApiSdk.getSkills({
      query: { limit, offset },
    });
    for (const s of data?.data ?? []) {
      skills.push({
        id: s.id,
        name: s.name,
        description: s.description,
        scope: s.scope,
        usageCount: s.usageCount,
      });
    }
    if (!data || data.data.length < limit) return skills;
  }
}

function shortToolName(name: string) {
  const i = name.indexOf("__");
  return i === -1 ? name : name.slice(i + 2);
}

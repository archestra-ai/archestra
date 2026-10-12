"use client";

// Data for the Connect page: gateway, servers, tools and their estimated
// context cost, skills, apps, admin settings.

import {
  ARCHESTRA_MCP_CATALOG_ID,
  type archestraApiTypes,
  type SupportedProvider,
} from "@archestra/shared";
import {
  CONNECT_SETUP_PARTS,
  INSTALLER_CLIENT_IDS,
} from "@archestra/shared/connection-setup";
import { useEffect, useMemo, useState } from "react";
import type { AgentSelectorAgent } from "@/components/agent-selector";
import { useDefaultMcpGateway, useProfiles } from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useConfig } from "@/lib/config/config.query";
import { useGuardrailsDeployment } from "@/lib/guardrails-deployment.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useLlmProxy } from "@/lib/llm-proxy.query";
import { useGatewayToolPreview } from "@/lib/mcp/gateway-tool-preview.query";
import { useOrganization } from "@/lib/organization.query";
import { isDeliverablePlugin, usePlugins } from "@/lib/plugins/plugin.query";
import { type ConnectSkill, useAllSkills } from "@/lib/skills/skill.query";
import {
  type ConnectClient,
  usesGenericInstructions,
  visibleClients,
} from "./clients";
import type { ConnectChoices, ConnectPicks } from "./connect-choices";
import {
  getConnectableProviders,
  useConnectionBaseUrl,
} from "./connection-flow.utils";
import { detectPlatform } from "./platform.utils";
import { useGatewayServers } from "./use-gateway-servers";

export interface ConnectServer {
  key: string;
  catalogId: string | null;
  name: string;
  /** Catalog icon; render with <McpCatalogIcon icon={...} catalogId={...} />. */
  icon: string | null;
  toolCount: number;
  tools: { name: string; description: string | null }[];
}

export type ConnectPageSkill = ConnectSkill;

/** What the setup adds to one agent. */
export interface ConnectFootprint {
  skillsInstalled: number;
}

export interface ConnectPlugin {
  id: string;
  /** What the installer's --plugins flag names it by. */
  slug: string;
  name: string;
  description: string | null;
  /** The GitHub repo it syncs from; null for an uploaded plugin. */
  source: string | null;
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
  /** Apps offered as tiles, in the admin order or the default installer order. */
  featuredClients: ConnectClient[];
  hasClientOrder: boolean;
  /** The app the admin picks first, when set. */
  defaultClientId: string | null;
  /** The instance's configured name ("Archestra" unless white-labeled). */
  appName: string;
  gateway: ConnectGateway | null;
  /** Gateways the user can pick instead; empty when they can't read them. */
  gateways: ConnectGateway[];
  /** The gateway a setup gets unless the user picks another. */
  defaultGatewayId: string | null;
  /** The admin's default endpoint; users don't pick one. */
  baseUrl: string;
  servers: ConnectServer[];
  totalTools: number | null;
  toolPreviewError: boolean;
  /** True when the gateway exposes every server in the org, incl. new ones. */
  allServers: boolean;
  skills: ConnectPageSkill[];
  totalSkills: number;
  /** Gateway "progressive tool loading": tools load on demand. */
  progressive: boolean;
  /**
   * Initial context cost of the gateway's served tool definitions.
   * `byServer` contains fallback estimates keyed by ConnectServer key for
   * initially loaded tools. It is empty for observed provider totals.
   * null until the preview loads.
   */
  toolTokens: {
    total: number;
    byServer: Record<string, number>;
    count?: archestraApiTypes.GetAgentMcpToolPreviewResponses[200]["tokenCount"];
  } | null;
  llmProxyEnabled: boolean;
  /** The org's LLM Proxy, when the user can route through it. */
  llmProxyId: string | null;
  /** Model providers the admin offers for routing. */
  shownProviders: SupportedProvider[];
  skillsEnabled: boolean;
  pluginsEnabled: boolean;
  /** Approved plugins the setup bundles for this client. */
  pluginsFor: (client: ConnectClient) => ConnectPlugin[];
  /** The plugins on offer that the user kept. */
  keptPlugins: (
    client: ConnectClient,
    pluginIds: ConnectPicks["pluginIds"],
  ) => ConnectPlugin[];
  /** Setup parts this client can get; the rest never show as choices. */
  partsFor: (client: ConnectClient) => ConnectChoices;
  /**
   * OpenAPPA guardrails on the LLM proxy: off, or on with what happens to
   * agents it doesn't support natively (pass through or blocked). null when
   * this user can't read the setting.
   */
  guardrails: { name: string; state: "off" | "bypass" | "block" | null };
  /** Can open /settings/connection (admin). */
  canManage: boolean;
  /** What connecting this client would create. */
  footprintFor: (client: ConnectClient) => ConnectFootprint;
  /**
   * The connect prompt for agents without an installer, carrying what the
   * user left out as connect.md's gateway/exclude/base params. null when
   * nothing is left to set up, and for apps with an installer.
   */
  connectPrompt: (
    client: ConnectClient,
    choices: ConnectChoices,
  ) => string | null;
  /**
   * The terminal command that runs the public installer for an app with one,
   * carrying what the user left out, and a gateway or plugins they picked
   * over the defaults. PowerShell on Windows, a POSIX shell elsewhere.
   */
  installerCommand: (
    client: ConnectClient,
    choices: ConnectChoices,
    windows: boolean,
    picks?: ConnectPicks,
  ) => string;
}

/** What connect.md?client=generic can set up; it has no plugins. */
const GENERIC_PARTS = ["tools", "skills", "proxy"] as const;

/**
 * The prompt for after connecting: the agent reads welcome.md, explores what
 * it was given and suggests what to ask next.
 */
export function welcomePrompt(origin: string, appName: string): string {
  return `Read ${origin}/welcome.md and show me what I can do with ${appName}.`;
}

/** A gateway pick that is no longer visible falls back to the default. */
export function useConnectPageData(
  pickedClientId?: string | null,
  pickedGatewayId: string | null = null,
): ConnectPageData {
  const appName = useAppName();
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

  const { data: defaultGateway, isLoading: defaultGatewayLoading } =
    useDefaultMcpGateway();
  const defaultGatewayId =
    org?.connectionDefaultMcpGatewayId ?? defaultGateway?.id ?? null;
  // The same list the browser approval offers.
  const { data: gatewayList, isPending: gatewaysPending } = useProfiles({
    filters: {
      agentTypes: ["profile", "mcp_gateway"],
      excludeOtherPersonalAgents: true,
    },
    enabled: canReadGateways === true,
  });
  const gateways = useMemo<ConnectGateway[]>(
    () => (gatewayList ?? []).map((g) => ({ ...g, slug: g.slug ?? g.id })),
    [gatewayList],
  );
  const gatewayId =
    (pickedGatewayId && gateways.some((g) => g.id === pickedGatewayId)
      ? pickedGatewayId
      : null) ??
    defaultGatewayId ??
    undefined;
  const {
    gateway: profile,
    profileQuery: { isPending: profilePending },
    accessAll,
    servers: gatewayServers,
  } = useGatewayServers(gatewayId, { withTools: true });
  const { data: canManage } = useHasPermissions({
    organizationSettings: ["read"],
  });
  const skillsEnabled = org?.connectionSkillsEnabled === true;
  const { data: skillList } = useAllSkills({
    enabled: skillsEnabled && canReadSkills === true,
  });

  const llmProxyEnabled = org?.connectionLlmProxyEnabled === true;
  const { data: llmProxy } = useLlmProxy({ enabled: llmProxyEnabled });
  const proxyAvailable =
    llmProxyEnabled && canReadLlmProxy === true && !!llmProxy?.id;

  const { data: guardrails } = useGuardrailsDeployment({ anyMember: true });

  const pluginsEnabled = org?.connectionPluginsEnabled === true;
  // Same eligibility and filter the setup uses to bundle plugins.
  const { data: allPlugins } = usePlugins(
    pluginsEnabled &&
      appConfig?.features.plugins === true &&
      canDeliverPlugins === true,
  );
  // The setup only bundles plugins built for the computer's OS.
  const [pluginPlatform, setPluginPlatform] = useState<"posix" | "windows">(
    "posix",
  );
  useEffect(
    () =>
      setPluginPlatform(detectPlatform() === "windows" ? "windows" : "posix"),
    [],
  );
  const pluginsFor = (client: ConnectClient): ConnectPlugin[] =>
    (allPlugins ?? [])
      .filter(
        (p) =>
          isDeliverablePlugin(p, client.id) &&
          p.supportedPlatforms.includes(pluginPlatform),
      )
      .map((p) => ({
        id: p.id,
        slug: p.pluginSlug,
        name: p.displayName,
        description: p.description,
        source: p.sourceRepo,
      }));

  const keptPlugins = (
    client: ConnectClient,
    pluginIds: ConnectPicks["pluginIds"],
  ) => {
    const offered = pluginsFor(client);
    if (pluginIds === null) return offered;
    const kept = new Set(pluginIds);
    return offered.filter((p) => kept.has(p.id));
  };

  const baseUrl = useConnectionBaseUrl(org?.connectionBaseUrls);

  const clients = useMemo(
    () =>
      visibleClients(org?.connectionShownClientIds, org?.connectionClientOrder),
    [org?.connectionShownClientIds, org?.connectionClientOrder],
  );
  const hasClientOrder = !!org?.connectionClientOrder?.length;
  const featuredClients = hasClientOrder
    ? clients.filter((client) => client.id !== "generic")
    : INSTALLER_CLIENT_IDS.map((id) => clients.find((c) => c.id === id)).filter(
        (c): c is ConnectClient => !!c,
      );

  const skills = skillList ?? [];
  const skillsAvailable = skillsEnabled && skills.length > 0;
  const gateway = profile
    ? { ...profile, slug: profile.slug ?? profile.id }
    : null;
  const toolsAvailable = canReadGateways === true && !!gateway;
  const client =
    clients.find((c) => c.id === pickedClientId) ??
    clients.find((c) => c.id === org?.connectionDefaultClientId) ??
    featuredClients[0] ??
    clients[0];
  const { data: preview, isError: toolPreviewError } = useGatewayToolPreview({
    agentId: toolsAvailable ? gateway?.id : undefined,
    client: client?.id === "claude-code" ? "claude-code" : "generic",
  });
  const listedTools = preview?.tools;
  const progressive =
    (preview?.toolExposureMode ?? profile?.toolExposureMode) ===
    "search_and_run_only";
  const totalTools = toolsAvailable ? (listedTools?.length ?? null) : 0;
  const servers = useMemo<ConnectServer[]>(() => {
    const inventory = gatewayServers.map(
      ({ catalogName, description: _, ...server }) => ({
        ...server,
        name: catalogName ?? "Other",
      }),
    );
    if (progressive || !listedTools) return inventory;
    const byKey = new Map(inventory.map((server) => [server.key, server]));
    const groups = new Map<string, ConnectServer>();
    for (const tool of listedTools) {
      const key = tool.catalogId ?? "other";
      let group = groups.get(key);
      if (!group) {
        group = {
          key,
          catalogId: tool.catalogId,
          name:
            byKey.get(key)?.name ??
            (key === ARCHESTRA_MCP_CATALOG_ID ? appName : "Other"),
          icon: byKey.get(key)?.icon ?? null,
          toolCount: 0,
          tools: [],
        };
        groups.set(key, group);
      }
      group.toolCount++;
      group.tools.push({
        name: tool.name.includes("__")
          ? tool.name.slice(tool.name.indexOf("__") + 2)
          : tool.name,
        description: tool.description,
      });
    }
    return [...groups.values()].sort((a, b) => b.toolCount - a.toolCount);
  }, [gatewayServers, listedTools, progressive, appName]);
  const toolTokens = useMemo(() => {
    if (!listedTools) return null;
    const byServer: Record<string, number> = {};
    let total = 0;
    for (const tool of listedTools) {
      total += tool.tokens;
      const key = tool.catalogId ?? "other";
      byServer[key] = (byServer[key] ?? 0) + tool.tokens;
    }
    const count = preview?.tokenCount;
    return {
      total: count?.total ?? total,
      // Provider counts cover the whole list; they cannot be apportioned to servers.
      byServer: count?.source === "claude-provider" ? {} : byServer,
      count,
    };
  }, [listedTools, preview?.tokenCount]);
  const partsFor = (client: ConnectClient): ConnectChoices => ({
    tools: toolsAvailable,
    skills: skillsAvailable,
    proxy: proxyAvailable && client.proxy.kind !== "unsupported",
    // Plugins come with the installer; other agents set themselves up.
    plugins: !usesGenericInstructions(client) && pluginsFor(client).length > 0,
  });

  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);

  const footprint: ConnectFootprint = {
    skillsInstalled: skillsEnabled ? skills.length : 0,
  };

  return {
    // Hold the skeleton until the gateway is known too: rendering without it
    // and then waiting on its profile played the page in twice.
    loading:
      orgPending ||
      (!org?.connectionDefaultMcpGatewayId && defaultGatewayLoading) ||
      // A picked gateway is only trusted once the list confirms it.
      (!!pickedGatewayId && canReadGateways === true && gatewaysPending) ||
      (!!gatewayId && profilePending),
    revalidating: orgQuery.isFetching,
    clients,
    featuredClients,
    hasClientOrder,
    defaultClientId: org?.connectionDefaultClientId ?? null,
    appName,
    gateway,
    gateways,
    defaultGatewayId,
    baseUrl,
    servers,
    totalTools,
    toolPreviewError,
    allServers: accessAll,
    skills,
    totalSkills: skills.length,
    progressive,
    toolTokens,
    llmProxyEnabled: proxyAvailable,
    llmProxyId: proxyAvailable ? (llmProxy?.id ?? null) : null,
    shownProviders: getConnectableProviders(org),
    skillsEnabled,
    pluginsEnabled,
    pluginsFor,
    keptPlugins,
    partsFor,
    guardrails: {
      name: "OpenAPPA",
      // No setting to read, or guardrails are unavailable: no chip at all.
      state:
        !guardrails || !guardrails.featureEnabled
          ? null
          : guardrails.active
            ? guardrails.unsupportedClientAction
            : "off",
    },
    canManage: canManage === true,
    footprintFor: () => footprint,
    connectPrompt: (client, choices) => {
      // Apps with an installer run it from the terminal instead.
      if (!usesGenericInstructions(client)) return null;
      const parts = partsFor(client);
      const on = (part: keyof ConnectChoices) => parts[part] && choices[part];
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
    installerCommand: (client, choices, windows, picks) => {
      const offered = pluginsFor(client);
      const kept = keptPlugins(client, picks?.pluginIds ?? null);
      // Keeping none of the plugins is leaving plugins out.
      const exclude = CONNECT_SETUP_PARTS.filter(
        (part) =>
          !choices[part] ||
          (part === "plugins" && offered.length > 0 && kept.length === 0),
      );
      const pickedGateway =
        choices.tools && gateway && gateway.id !== defaultGatewayId
          ? gateway.slug
          : null;
      const somePlugins =
        choices.plugins && kept.length > 0 && kept.length < offered.length;
      // Two lines: fetch the installer, then run it. The continuation
      // (a backtick in PowerShell) keeps it one command when pasted.
      const [fetch, next] = windows ? ["irm", "`"] : ["curl -fsSL", "\\"];
      const flags = [
        `--url ${origin}`,
        `--client ${client.id}`,
        ...(exclude.length ? [`--exclude ${exclude.join(",")}`] : []),
        ...(pickedGateway ? [`--gateway ${pickedGateway}`] : []),
        ...(somePlugins
          ? [`--plugins ${kept.map((p) => p.slug).join(",")}`]
          : []),
      ];
      return `${fetch} ${origin}/api/client-connections/installer ${next}\n  | node - ${flags.join(" ")}`;
    },
  };
}

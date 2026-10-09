"use client";

// Data for the Connect page: gateway, servers, tools and their estimated
// context cost, skills, apps, admin settings.

import {
  isAgentTool,
  isSkillTool,
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
import { useChatProfileMcpTools } from "@/lib/chat/chat.query";
import { useConfig } from "@/lib/config/config.query";
import { useGuardrailsDeployment } from "@/lib/guardrails-deployment.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useLlmProxy } from "@/lib/llm-proxy.query";
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
  totalTools: number;
  /** True when the gateway exposes every server in the org, incl. new ones. */
  allServers: boolean;
  skills: ConnectPageSkill[];
  totalSkills: number;
  /** Gateway "progressive tool loading": tools load on demand. */
  progressive: boolean;
  /**
   * Estimated tokens the gateway's tool list takes in the agent's context,
   * counted from the same tool list and tokenizer as the chat's context
   * window view. `byServer` is keyed by ConnectServer key and only has the
   * servers whose tools load at session start. null until it loads.
   */
  toolTokens: { total: number; byServer: Record<string, number> } | null;
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

/**
 * `pickedGatewayId`: a gateway the user picked over the default. One they
 * can no longer see falls back to the default.
 */
export function useConnectPageData(
  pickedGatewayId: string | null = null,
): ConnectPageData {
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

  const servers = useMemo<ConnectServer[]>(
    () =>
      gatewayServers.map(({ catalogName, description: _, ...server }) => ({
        ...server,
        name: catalogName ?? "Other",
      })),
    [gatewayServers],
  );
  const totalTools = servers.reduce((n, s) => n + s.toolCount, 0);
  const progressive = profile?.toolExposureMode === "search_and_run_only";

  const skills = skillList ?? [];
  const skillsAvailable = skillsEnabled && skills.length > 0;
  const gateway = profile
    ? { ...profile, slug: profile.slug ?? profile.id }
    : null;
  const toolsAvailable = canReadGateways === true && !!gateway;
  // The gateway's real tool list, as the agent gets it: in on-demand mode
  // that's the small fixed set, in full mode every server's tools.
  const { data: listedTools } = useChatProfileMcpTools(
    toolsAvailable ? gateway?.id : undefined,
    { silent: true },
  );
  const toolTokens = useMemo(() => {
    if (!listedTools?.length) return null;
    const serverOf = new Map(
      (profile?.tools ?? []).map((t) => [t.name, t.catalogId ?? "other"]),
    );
    const byServer: Record<string, number> = {};
    let total = 0;
    for (const tool of listedTools) {
      // The chat's list adds agent and skill delegation tools, but an
      // on-demand gateway never sends those to a connected agent (any agent,
      // not only Claude Code), so they don't count toward its context.
      if (progressive && (isAgentTool(tool.name) || isSkillTool(tool.name)))
        continue;
      total += tool.tokens;
      const key = serverOf.get(tool.name);
      if (key) byServer[key] = (byServer[key] ?? 0) + tool.tokens;
    }
    return { total, byServer };
  }, [listedTools, profile?.tools, progressive]);
  const partsFor = (client: ConnectClient): ConnectChoices => ({
    tools: toolsAvailable,
    skills: skillsAvailable,
    proxy: proxyAvailable && client.proxy.kind !== "unsupported",
    // Plugins come with the installer; other agents set themselves up.
    plugins: !usesGenericInstructions(client) && pluginsFor(client).length > 0,
  });

  const appName = useAppName();

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
      // No setting to read, or the guardrails beta is off: no chip at all.
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

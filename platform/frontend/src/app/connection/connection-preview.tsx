"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { BookOpen, Bot, Puzzle, Server, Wrench } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { FilterSelect } from "@/components/filter-bar";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { Switch } from "@/components/ui/switch";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { DEFAULT_FILTER_ALL } from "@/consts";
import { useProfile } from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useConfig } from "@/lib/config/config.query";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import { type LlmModel, useLlmModels } from "@/lib/llm-models.query";
import {
  groupCatalogTools,
  useAllCatalogTools,
  useInternalMcpCatalog,
} from "@/lib/mcp/internal-mcp-catalog.query";
import { usePlugins } from "@/lib/plugins/plugin.query";
import type { ConnectClient } from "./clients";
import {
  ALL_INCLUDED,
  type ConnectChoices,
  readConnectChoices,
  saveConnectChoices,
} from "./connect-choices";
import { useConnectSkills } from "./connect-command-panel";
import { PreviewTableDialog } from "./connection-preview-dialogs";
import type { ConnectSkill } from "./skills-marketplace-step";

/*
 * Variant 7 — variant 2 with source attribution. Each row carries a trailing
 * one legend line under the table explains that only tools come through the
 * gateway, skills and models come from Archestra.
 *
 * Base: variant 2 — "Servers row, tools nested beneath".
 * Click targets are the nouns themselves, inline, styled like the LLM Proxy
 * link. Tools hang off the servers line as an indented sub-line so the two
 * counts read as parent/child instead of two competing links. The only icons
 * are a 3-logo stack on the servers line, where they identify real servers.
 */

interface ServerRow {
  key: string;
  catalogId: string | null;
  name: string;
  icon: string | null;
  toolCount: number;
  tools: { name: string; description: string | null }[];
}

interface ToolRow {
  key: string;
  name: string;
  description: string | null;
  server: ServerRow;
}

type ModelRow = LlmModel & { providerLabel: string };

type Plugin = NonNullable<ReturnType<typeof usePlugins>["data"]>[number];

/** Which table is open; tools can be narrowed to one server. */
type View =
  | { kind: "servers" | "skills" | "plugins" | "models" }
  | { kind: "tools"; server: string | null }
  | null;

const LINK =
  "rounded-sm font-medium text-foreground underline decoration-muted-foreground/40 underline-offset-2 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

interface ConnectionPreviewProps {
  client: ConnectClient;
  /** The gateway the approval will default to; null when none is readable. */
  gateway: { id: string; name: string } | null;
  /** Whether the approval will offer routing through the LLM Proxy. */
  proxyAvailable: boolean;
  skillsEnabled: boolean;
  /** Org setting; plugins also need the deployment flag and plugin rights. */
  pluginsEnabled?: boolean;
  /**
   * False when the agent sets itself up from the generic prompt: there is no
   * browser approval, so the switches feed the prompt instead.
   */
  viaApproval?: boolean;
  /** Called with the switches' current state, on load and on every change. */
  onIncludedChange?: (choices: ConnectChoices) => void;
}

export function ConnectionPreview({
  client,
  gateway,
  proxyAvailable,
  skillsEnabled,
  pluginsEnabled = true,
  viaApproval = true,
  onIncludedChange,
}: ConnectionPreviewProps) {
  const { data: profile } = useProfile(gateway?.id);
  const { data: catalog } = useInternalMcpCatalog();
  const { eligible: skillsEligible, skills } = useConnectSkills(skillsEnabled);
  // Same eligibility and filter the setup uses to bundle plugins by default.
  const { data: configData } = useConfig();
  const { data: canDeliverPlugins } = useHasPermissions(
    { plugin: ["read", "update"] },
    "*",
  );
  const { data: allPlugins } = usePlugins(
    pluginsEnabled &&
      configData?.features.plugins === true &&
      canDeliverPlugins === true,
  );
  const plugins = useMemo(
    () =>
      (allPlugins ?? []).filter(
        (plugin) =>
          plugin.clientType === client.id &&
          plugin.enabled &&
          plugin.approvedContentHash === plugin.contentHash,
      ),
    [allPlugins, client.id],
  );
  const [view, setView] = useState<View>(null);
  // The approval page reads these back when it builds the setup.
  const [included, setIncluded] = useState<ConnectChoices>(ALL_INCLUDED);
  // biome-ignore lint/correctness/useExhaustiveDependencies: load once per client
  useEffect(() => {
    const saved = readConnectChoices(client.id);
    setIncluded(saved);
    onIncludedChange?.(saved);
  }, [client.id]);
  const include = (key: keyof ConnectChoices) => (value: boolean) => {
    const next = { ...included, [key]: value };
    setIncluded(next);
    saveConnectChoices(client.id, next);
    onIncludedChange?.(next);
  };
  const accessAll = profile?.accessAllTools ?? false;
  // The gateway's "Progressive tool loading" setting: only the search/run
  // meta-tools are listed, and the rest load when the agent asks for them.
  const progressive = profile?.toolExposureMode === "search_and_run_only";

  // A gateway that exposes everything has no tool list of its own; read the
  // registry's names once the tools table is opened.
  const { data: catalogTools, isPending: catalogToolsLoading } =
    useAllCatalogTools({
      enabled: accessAll && view?.kind === "tools",
    });

  const servers = useMemo<ServerRow[]>(() => {
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
          tools: (toolsByCatalog.get(c.id) ?? [])
            .map((t) => ({ name: shortToolName(t.name), description: null }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        }))
        .sort((a, b) => b.toolCount - a.toolCount);
    }
    const groups = new Map<string | null, ServerRow["tools"]>();
    for (const t of profile?.tools ?? []) {
      const list = groups.get(t.catalogId) ?? [];
      list.push({ name: shortToolName(t.name), description: t.description });
      groups.set(t.catalogId, list);
    }
    return [...groups.entries()]
      .map(([catalogId, tools]) => {
        const item = catalogId ? byId.get(catalogId) : undefined;
        const fallback = (profile?.tools ?? [])
          .find((t) => t.catalogId === catalogId)
          ?.name.split("__")[0];
        return {
          key: catalogId ?? "catalogless",
          catalogId,
          name: item?.name ?? capitalize(fallback ?? "Unknown"),
          icon: item?.icon ?? null,
          toolCount: tools.length,
          tools: tools.sort((a, b) => a.name.localeCompare(b.name)),
        };
      })
      .sort((a, b) => b.toolCount - a.toolCount);
  }, [accessAll, profile?.tools, catalog, catalogTools]);

  const totalTools = servers.reduce((s, r) => s + r.toolCount, 0);
  const toolServer = view?.kind === "tools" ? view.server : null;
  const shownTools = useMemo<ToolRow[]>(
    () =>
      servers
        .filter((s) => !toolServer || s.key === toolServer)
        .flatMap((s) =>
          s.tools.map((t) => ({ key: `${s.key}:${t.name}`, ...t, server: s })),
        ),
    [servers, toolServer],
  );

  // Only fetched once the table is opened; narrowed to what the client speaks.
  const { data: allModels, isPending: modelsLoading } = useLlmModels({
    enabled: view?.kind === "models",
  });
  const providers = useModelProviderCatalog();
  const models = useMemo<ModelRow[]>(() => {
    const speaks =
      client.proxy.kind === "custom"
        ? new Set<string>(client.proxy.supportedProviders)
        : null;
    return (allModels ?? [])
      .filter((m) => !speaks || speaks.has(m.provider))
      .map((m) => ({ ...m, providerLabel: providers.label(m.provider) }));
  }, [allModels, client.proxy, providers]);

  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-[62ch] text-sm leading-relaxed text-muted-foreground">
        {gateway ? (
          <>
            {client.label} connects to{" "}
            <UnstyledButton
              type="button"
              className={LINK}
              onClick={() => setView({ kind: "tools", server: null })}
            >
              {gateway.name}
            </UnstyledButton>
            , the gateway your admin picked, for its tools. Skills and model
            routing come from Archestra itself.
            {viaApproval && <span> One approval sets up both.</span>}
          </>
        ) : viaApproval ? (
          <>Once you approve, {client.label} is set up with everything below.</>
        ) : (
          <>Your agent sets up {client.label} with everything below.</>
        )}
      </p>

      <div
        id="connect-setup-details"
        className="flex flex-col gap-4 animate-in fade-in-0 slide-in-from-top-1 duration-200"
      >
        <div className="grid border-y border-border/70 text-sm">
          {gateway && (
            <Row
              label="Tools"
              included={included.tools}
              onIncludedChange={include("tools")}
            >
              <div className="grid gap-1">
                <span className="flex min-w-0 items-center gap-2">
                  {servers.length > 0 && (
                    <span className="flex shrink-0 items-center -space-x-1">
                      {servers.slice(0, 3).map((s) => (
                        <span
                          key={s.key}
                          className="grid size-5 place-items-center rounded-full bg-background ring-1 ring-border"
                        >
                          <McpCatalogIcon
                            icon={s.icon}
                            catalogId={s.catalogId ?? undefined}
                            size={12}
                          />
                        </span>
                      ))}
                    </span>
                  )}
                  <span className="truncate text-foreground">
                    {servers.length === 0 ? (
                      <span className="text-muted-foreground">
                        No MCP servers exposed yet
                      </span>
                    ) : (
                      <>
                        From{" "}
                        <UnstyledButton
                          type="button"
                          className={LINK}
                          onClick={() => setView({ kind: "servers" })}
                        >
                          {plural(servers.length, "MCP server")}
                        </UnstyledButton>
                        {accessAll && (
                          <span className="text-muted-foreground">
                            {" "}
                            (all in your org, incl. new ones)
                          </span>
                        )}
                      </>
                    )}
                  </span>
                </span>
                {totalTools > 0 && (
                  <span className="flex items-center gap-1.5 pl-[1.4rem] text-xs text-muted-foreground">
                    <span aria-hidden className="text-muted-foreground/50">
                      └
                    </span>
                    <span>
                      exposing{" "}
                      <UnstyledButton
                        type="button"
                        className={`${LINK} font-normal`}
                        onClick={() => setView({ kind: "tools", server: null })}
                      >
                        {plural(totalTools, "tool")}
                      </UnstyledButton>{" "}
                      your agent can call
                    </span>
                  </span>
                )}
                {totalTools > 0 && (
                  <span className="pl-[1.4rem] text-xs text-muted-foreground">
                    {progressive
                      ? "Loaded on demand, so they don't fill your agent's context up front."
                      : "All of them sit in your agent's context from the first message."}
                  </span>
                )}
              </div>
            </Row>
          )}
          {skillsEligible && (
            <Row
              label="Skills"
              included={included.skills}
              onIncludedChange={include("skills")}
            >
              {skills.length === 0 ? (
                <span className="text-muted-foreground">
                  None available yet
                </span>
              ) : (
                <span className="text-foreground">
                  <UnstyledButton
                    type="button"
                    className={LINK}
                    onClick={() => setView({ kind: "skills" })}
                  >
                    {plural(skills.length, "skill")}
                  </UnstyledButton>{" "}
                  your agent can load on demand
                </span>
              )}
            </Row>
          )}
          {plugins.length > 0 && (
            <Row
              label="Plugins"
              included={included.plugins}
              onIncludedChange={include("plugins")}
            >
              <span className="text-foreground">
                <UnstyledButton
                  type="button"
                  className={LINK}
                  onClick={() => setView({ kind: "plugins" })}
                >
                  {plural(plugins.length, "plugin")}
                </UnstyledButton>{" "}
                installed into {client.label}
              </span>
            </Row>
          )}
          {proxyAvailable && (
            <Row
              label="Model requests"
              included={included.proxy}
              onIncludedChange={include("proxy")}
            >
              <span className="text-foreground">
                {client.id === "cursor" ? (
                  <>
                    <UnstyledButton
                      type="button"
                      className={LINK}
                      onClick={() => setView({ kind: "models" })}
                    >
                      LLM Proxy
                    </UnstyledButton>{" "}
                    settings prepared; finish setup in Cursor Settings
                  </>
                ) : (
                  <>
                    Routed through{" "}
                    <UnstyledButton
                      type="button"
                      className={LINK}
                      onClick={() => setView({ kind: "models" })}
                    >
                      the LLM Proxy
                    </UnstyledButton>
                  </>
                )}
              </span>
            </Row>
          )}
        </div>

        <div className="grid gap-1 text-xs text-muted-foreground">
          {gateway && (skillsEligible || proxyAvailable) && (
            <p className="max-w-[62ch]">
              Tools come from {gateway.name}; skills and model routing come from
              Archestra.
            </p>
          )}
          <p>
            {viaApproval
              ? "You can change this when you approve in your browser."
              : `Your agent skips anything ${client.label} doesn't support.`}
          </p>
        </div>
      </div>

      <PreviewTableDialog
        open={view?.kind === "servers"}
        onClose={() => setView(null)}
        title="MCP servers"
        description={`${plural(servers.length, "server")} reachable through ${gateway?.name ?? "the gateway"}.`}
        manage={{ href: "/mcp/registry", label: "Open the registry" }}
        searchPlaceholder="Search servers"
        rows={servers}
        columns={SERVER_COLUMNS}
        getRowId={(s) => s.key}
        matches={(s, q) => s.name.toLowerCase().includes(q)}
        onRowClick={(s) => setView({ kind: "tools", server: s.key })}
        emptyIcon={Server}
        emptyMessage="No MCP servers exposed yet"
      />
      <PreviewTableDialog
        open={view?.kind === "tools"}
        onClose={() => setView(null)}
        title={gateway?.name ?? "Tools"}
        description={
          accessAll
            ? `Every tool in your org: ${plural(totalTools, "tool")} across ${plural(servers.length, "server")}.`
            : `${plural(totalTools, "tool")} across ${plural(servers.length, "server")}.`
        }
        manage={
          gateway
            ? { href: `/mcp/gateways/${gateway.id}`, label: "Open the gateway" }
            : undefined
        }
        searchPlaceholder="Search tools"
        rows={shownTools}
        loading={accessAll && catalogToolsLoading}
        // The registry's names come without descriptions.
        columns={accessAll ? TOOL_COLUMNS.slice(0, 1) : TOOL_COLUMNS}
        getRowId={(t) => t.key}
        matches={(t, q) =>
          t.name.toLowerCase().includes(q) ||
          (t.description ?? "").toLowerCase().includes(q)
        }
        filters={
          servers.length > 1 ? (
            <FilterSelect
              value={toolServer ?? DEFAULT_FILTER_ALL}
              onValueChange={(value) =>
                setView({
                  kind: "tools",
                  server: value === DEFAULT_FILTER_ALL ? null : value,
                })
              }
              placeholder="MCP server"
              items={[
                { value: DEFAULT_FILTER_ALL, label: "All MCP servers" },
                ...servers.map((s) => ({ value: s.key, label: s.name })),
              ]}
            />
          ) : undefined
        }
        onClearFilters={
          toolServer
            ? () => setView({ kind: "tools", server: null })
            : undefined
        }
        emptyIcon={Wrench}
        emptyMessage="No tools to list"
      />
      <PreviewTableDialog
        open={view?.kind === "skills"}
        onClose={() => setView(null)}
        title="Skills"
        description={`${plural(skills.length, "skill")} your agent can load on demand.`}
        manage={{ href: "/skills", label: "Manage skills" }}
        searchPlaceholder="Search skills"
        rows={skills}
        columns={SKILL_COLUMNS}
        getRowId={(s) => s.id}
        matches={(s, q) => s.name.toLowerCase().includes(q)}
        emptyIcon={BookOpen}
        emptyMessage="No skills available yet"
      />
      <PreviewTableDialog
        open={view?.kind === "plugins"}
        onClose={() => setView(null)}
        title="Plugins"
        description={`${plural(plugins.length, "plugin")} installed into ${client.label}.`}
        manage={{ href: "/plugins", label: "Manage plugins" }}
        searchPlaceholder="Search plugins"
        rows={plugins}
        columns={PLUGIN_COLUMNS}
        getRowId={(p) => p.id}
        matches={(p, q) =>
          p.displayName.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q)
        }
        emptyIcon={Puzzle}
        emptyMessage={`No plugins for ${client.label}`}
      />
      <PreviewTableDialog
        open={view?.kind === "models"}
        onClose={() => setView(null)}
        title="LLM Proxy"
        description={`Models ${client.label} can request through the LLM Proxy.`}
        manage={{ href: "/llm/proxy", label: "Open the LLM Proxy" }}
        searchPlaceholder="Search models"
        rows={models}
        columns={MODEL_COLUMNS}
        getRowId={(m) => m.dbId}
        matches={(m, q) =>
          m.displayName.toLowerCase().includes(q) ||
          m.id.toLowerCase().includes(q) ||
          m.providerLabel.toLowerCase().includes(q)
        }
        loading={modelsLoading}
        emptyIcon={Bot}
        emptyMessage="No models available yet"
        emptyDescription="Models appear once an admin adds a provider key."
      />
    </div>
  );
}

function Row({
  label,
  children,
  included,
  onIncludedChange,
}: {
  label: string;
  children: ReactNode;
  /** Coarse on/off for this part of the setup. */
  included: boolean;
  onIncludedChange: (included: boolean) => void;
}) {
  return (
    <div className="grid grid-cols-[8.5rem_minmax(0,1fr)_auto] items-start gap-4 py-2.5 [&+&]:border-t [&+&]:border-border/40">
      <span className="pt-0.5 text-muted-foreground">{label}</span>
      <div
        className={`min-w-0 transition-opacity ${included ? "" : "pointer-events-none opacity-40"}`}
      >
        {children}
      </div>
      <Switch
        aria-label={`Include ${label.toLowerCase()}`}
        checked={included}
        onCheckedChange={onIncludedChange}
      />
    </div>
  );
}

const SERVER_COLUMNS: ColumnDef<ServerRow>[] = [
  {
    id: "server",
    header: "MCP server",
    cell: ({ row }) => (
      <span className="flex items-center gap-2">
        <McpCatalogIcon
          icon={row.original.icon}
          catalogId={row.original.catalogId ?? undefined}
          size={16}
        />
        <span>{row.original.name}</span>
      </span>
    ),
  },
  {
    id: "tools",
    header: "Tools",
    size: 100,
    cell: ({ row }) => (
      <span className="tabular-nums text-muted-foreground">
        {row.original.toolCount.toLocaleString()}
      </span>
    ),
  },
];

const TOOL_COLUMNS: ColumnDef<ToolRow>[] = [
  {
    id: "tool",
    header: "Tool",
    size: 220,
    cell: ({ row }) => (
      <div className="grid gap-0.5">
        <span className="font-mono text-xs">{row.original.name}</span>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <McpCatalogIcon
            icon={row.original.server.icon}
            catalogId={row.original.server.catalogId ?? undefined}
            size={12}
          />
          {row.original.server.name}
        </span>
      </div>
    ),
  },
  {
    id: "description",
    header: "What it does",
    cell: ({ row }) => (
      <span className="line-clamp-2 text-xs text-muted-foreground">
        {row.original.description}
      </span>
    ),
  },
];

const SKILL_COLUMNS: ColumnDef<ConnectSkill>[] = [
  { id: "skill", header: "Skill", cell: ({ row }) => row.original.name },
  {
    id: "shared",
    header: "Shared with",
    cell: ({ row }) => (
      <span className="text-muted-foreground">
        {sharedWith(row.original.scope, row.original.teams)}
      </span>
    ),
  },
];

const PLUGIN_COLUMNS: ColumnDef<Plugin>[] = [
  {
    id: "plugin",
    header: "Plugin",
    size: 200,
    cell: ({ row }) => row.original.displayName,
  },
  {
    id: "description",
    header: "What it does",
    cell: ({ row }) => (
      <span className="line-clamp-2 text-xs text-muted-foreground">
        {row.original.description}
      </span>
    ),
  },
  {
    id: "shared",
    header: "Shared with",
    size: 140,
    cell: ({ row }) => (
      <span className="text-muted-foreground">
        {sharedWith(row.original.scope, row.original.teams)}
      </span>
    ),
  },
];

const MODEL_COLUMNS: ColumnDef<ModelRow>[] = [
  {
    id: "model",
    header: "Model",
    cell: ({ row }) => (
      <div className="grid gap-0.5">
        <span>{row.original.displayName}</span>
        {row.original.id !== row.original.displayName && (
          <span className="font-mono text-xs text-muted-foreground">
            {row.original.id}
          </span>
        )}
      </div>
    ),
  },
  {
    id: "provider",
    header: "Provider",
    size: 140,
    cell: ({ row }) => (
      <span className="text-muted-foreground">
        {row.original.providerLabel}
      </span>
    ),
  },
  {
    id: "context",
    header: "Context",
    size: 100,
    cell: ({ row }) => {
      const tokens = row.original.capabilities?.contextLength;
      return (
        <span className="tabular-nums text-muted-foreground">
          {tokens ? tokenCount(tokens) : "—"}
        </span>
      );
    },
  },
];

function sharedWith(
  scope: "personal" | "team" | "org",
  teams: { name: string }[],
): string {
  if (scope === "org") return "Everyone";
  if (scope === "team") return teams.map((t) => t.name).join(", ") || "Teams";
  return "Only you";
}

function tokenCount(tokens: number): string {
  return tokens >= 1_000_000
    ? `${+(tokens / 1_000_000).toFixed(1)}M`
    : `${Math.round(tokens / 1000)}k`;
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${n === 1 ? word : `${word}s`}`;
}

function shortToolName(name: string): string {
  const i = name.indexOf("__");
  return i >= 0 ? name.slice(i + 2) : name;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

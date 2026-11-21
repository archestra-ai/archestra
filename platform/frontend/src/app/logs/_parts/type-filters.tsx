"use client";

import {
  CLIENT_FILTER_OPTIONS,
  type InteractionSource,
} from "@archestra/shared";
import {
  Bot,
  BrainCircuit,
  Building2,
  CircleAlert,
  CircleCheck,
  CircleX,
  Cpu,
  Eye,
  Gauge,
  KeyRound,
  Laptop,
  LogIn,
  type LucideIcon,
  Mail,
  Plug,
  RefreshCw,
  ScrollText,
  Server,
  Shield,
  ShieldCheck,
  Sparkles,
  Unplug,
  User,
  Users,
  Wrench,
} from "lucide-react";
import type { ReactNode } from "react";
import { auditResourceIcon } from "@/app/audit/logs/_parts/audit-event-taxonomy";
import { AgentIdenticon, PersonAvatar } from "@/app/llm/logs/_parts/hue-avatar";
import { MakerDisc } from "@/app/llm/logs/_parts/maker-disc";
import { AgentIcon } from "@/components/agent-icon";
import { useCompactFilters } from "@/components/filter-bar";
import { ClientFilterOption } from "@/components/log-filter-option";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { ClientIcon } from "@/components/provider-icon";
import { SourceIcon } from "@/components/source-badge";
import {
  type LogEvent,
  type LogEventsQuery,
  type LogEventsResponse,
  type LogFacetCount,
  type LogSource,
  type LogStatus,
  useLogEvents,
} from "@/lib/logs/log-events.query";
import { cn } from "@/lib/utils/tailwind";
import { type ChipOption, FilterChip } from "./filter-chip";
import { type PaneGroup, PanePicker, SectionsChip } from "./pane-picker";

type Getter = (key: string) => string | undefined;
type Setter = (patch: Record<string, string | undefined>) => void;
type Facets = LogEventsResponse["facets"];

export const PROBLEM_STATUSES: LogStatus[] = [
  "error",
  "blocked",
  "pending",
  "warning",
];

/** The chosen type's own filters, mirroring that type's logs page today. */
export function TypeFilters({
  type,
  facets,
  filters,
  get,
  set,
}: {
  type: LogSource | undefined;
  facets?: Facets;
  /** The live query, so two-pane pickers can count without their own filter. */
  filters: LogEventsQuery;
  get: Getter;
  set: Setter;
}) {
  if (!type) return null;
  if (type === "llm" || type === "mcp")
    return (
      <AgentTrafficFilters
        type={type}
        facets={facets}
        hours={filters.hours ?? 24}
        get={get}
        set={set}
        trailing={null}
      />
    );
  if (type === "guardrails")
    return <GuardrailFilters facets={facets} get={get} set={set} />;
  if (type === "connections")
    return (
      <>
        <UserChip type={type} facets={facets} get={get} set={set} />
        <FilterChip
          name="Action"
          idleLabel="All actions"
          allLabel="All actions"
          value={get("connectionAction")}
          options={(facets?.connectionAction ?? []).map((f) => {
            const a = CONNECTION[f.value];
            return {
              value: f.value,
              label: a?.label ?? f.value,
              description: a?.description,
              count: f.count,
              mark: <ActionIcon icon={a?.icon ?? Plug} tone={a?.tone} />,
            };
          })}
          onChange={(v) => set({ connectionAction: v })}
        />
      </>
    );
  return <AuditFilters filters={filters} get={get} set={set} />;
}

// ===== LLM Proxy and MCP Gateway =====

function AgentTrafficFilters({
  type,
  facets,
  hours,
  get,
  set,
  trailing,
}: {
  type: "llm" | "mcp";
  facets?: Facets;
  hours: number;
  get: Getter;
  set: Setter;
  trailing: ReactNode;
}) {
  // Facets carry names only; one wide page of this type tells each agent's
  // kind and id (for the identicon the rows use) and each model's maker.
  const dir = useDirectory(type);
  void hours;

  const agentOptions: ChipOption[] = (facets?.agent ?? [])
    .map((f) => {
      const a = dir.agents.get(f.value);
      const kind = a?.kind ?? "agent";
      return {
        value: f.value,
        label: f.value,
        count: f.count,
        group: AGENT_KIND_HEADING[kind],
        order: AGENT_KIND_ORDER[kind],
        // AgentSelector's own mark: the agent's icon, or its kind's glyph.
        mark: (
          <AgentIcon
            icon={null}
            fallbackType={kind}
            className="text-muted-foreground"
          />
        ),
      };
    })
    .sort((x, y) => x.order - y.order)
    .map(({ order: _o, ...o }) => o);
  const multiKind = new Set(agentOptions.map((o) => o.group)).size > 1;
  const agentChip = (
    <FilterChip
      name="Agent"
      idleLabel={type === "mcp" ? "All agents & MCP gateways" : "All agents"}
      allLabel={type === "mcp" ? "All agents & MCP gateways" : "All agents"}
      searchPlaceholder={
        type === "mcp" ? "Search agents and MCP gateways…" : "Search agents…"
      }
      value={get("agent")}
      width={type === "mcp" ? "min-w-[17rem]" : undefined}
      options={
        multiKind
          ? agentOptions
          : agentOptions.map((o) => ({ ...o, group: undefined }))
      }
      searchable
      onChange={(v) => set({ agent: v })}
    />
  );
  const userChip = <UserChip type={type} facets={facets} get={get} set={set} />;

  if (type === "mcp")
    return (
      <>
        {agentChip}
        <FilterChip
          name="Server"
          idleLabel="All MCP servers"
          allLabel="All MCP servers"
          searchPlaceholder="Search MCP servers…"
          value={get("mcpServer")}
          options={(facets?.mcpServer ?? []).map((f) => ({
            value: f.value,
            label: f.value,
            count: f.count,
            mark: <ServerMark />,
          }))}
          searchable
          onChange={(v) => set({ mcpServer: v })}
        />
        {userChip}
        {trailing}
      </>
    );

  return (
    <>
      {agentChip}
      {userChip}
      <SectionsChip
        idleLabel="All apps & models"
        searchPlaceholder="Search apps and models…"
        sections={[
          {
            heading: "Client apps",
            allLabel: "All client apps",
            value: get("client"),
            onChange: (v) => set({ client: v }),
            options: (facets?.client ?? []).map((f) => ({
              value: f.value,
              label: f.value,
              count: f.count,
              mark: <ClientMark name={f.value} />,
              content: <ClientOption name={f.value} />,
            })),
          },
          {
            heading: "Models",
            allLabel: "All models",
            value: get("model"),
            onChange: (v) => set({ model: v }),
            options: (facets?.model ?? []).map((f) => {
              const provider = dir.models.get(f.value);
              return {
                value: f.value,
                label: f.value,
                description: provider ? PROVIDER_LABEL[provider] : undefined,
                count: f.count,
                mark: provider ? (
                  <MakerDisc
                    provider={provider}
                    vendor={provider}
                    size={16}
                    ring={false}
                  />
                ) : (
                  <IconTile icon={Sparkles} tone="violet" />
                ),
              };
            }),
          },
        ]}
      />
      {trailing}
    </>
  );
}

/** "All users": people with avatars; other principals under their own heading. */
function UserChip({
  type,
  facets,
  get,
  set,
}: {
  type: LogSource;
  facets?: Facets;
  get: Getter;
  set: Setter;
}) {
  const dir = useDirectory(type);
  const options = (facets?.actorByKind ?? [])
    .map((f) => {
      const [kind, actor] = splitPair(f.value);
      return {
        value: actor,
        label: actor,
        count: f.count,
        description: dir.emails.get(actor),
        group: ACTOR_KIND[kind]?.label ?? "Other",
        order: ACTOR_KIND[kind]?.order ?? 9,
        mark: actorMark(kind, actor),
      };
    })
    .sort((a, b) => a.order - b.order)
    .map(({ order: _o, ...o }) => o);
  const multiKind = new Set(options.map((o) => o.group)).size > 1;
  return (
    <FilterChip
      name="User"
      idleLabel="All users"
      allLabel="All users"
      searchPlaceholder="Search users…"
      value={get("actor")}
      options={
        multiKind ? options : options.map((o) => ({ ...o, group: undefined }))
      }
      searchable
      onChange={(v) => set({ actor: v })}
    />
  );
}

// ===== Guardrails =====

function GuardrailFilters({
  facets,
  get,
  set,
}: {
  facets?: Facets;
  get: Getter;
  set: Setter;
}) {
  const dc = (d: string) =>
    facets?.decision.find((f) => f.value === d)?.count ?? 0;
  const record = get("record");
  return (
    <>
      <FilterChip
        name="Record type"
        idleLabel="All records"
        allLabel="All records"
        value={record}
        options={[
          {
            value: "consult",
            label: "Consults",
            description: "Checks Guardrails ran before a tool call",
            count: dc("consult") + dc("allow") + dc("deny") + dc("review"),
            mark: <ActionIcon icon={ShieldCheck} tone="text-amber-500" />,
          },
          {
            value: "yell",
            label: "Yells",
            description: "Blocks an agent disputed",
            count: dc("yell"),
            mark: <ActionIcon icon={CircleAlert} tone="text-fuchsia-500" />,
          },
        ]}
        onChange={(v) =>
          set({
            record: v,
            decision: v === "yell" ? undefined : get("decision"),
          })
        }
      />
      {record !== "yell" && dc("allow") + dc("deny") + dc("review") > 0 && (
        <FilterChip
          name="Decision"
          idleLabel="All decisions"
          allLabel="All decisions"
          value={get("decision")}
          options={(["allow", "deny", "review"] as const).map((d) => ({
            value: d,
            label: DECISION[d].label,
            description: DECISION[d].description,
            count: dc(d),
            mark: <Dot className={DECISION[d].dot} />,
          }))}
          onChange={(v) => set({ decision: v })}
        />
      )}
    </>
  );
}

// ===== Audit =====

function AuditFilters({
  filters,
  get,
  set,
}: {
  filters: LogEventsQuery;
  get: Getter;
  set: Setter;
}) {
  const compact = useCompactFilters();
  // Each picker counts as if its own filter were off, so its left pane keeps
  // every group after one is picked.
  const without = (...keys: (keyof LogEventsQuery)[]): LogEventsQuery => {
    const q: LogEventsQuery = { ...filters, cursor: undefined, limit: 1 };
    for (const k of keys) delete q[k];
    return q;
  };
  const eventFacets = useLogEvents(without("auditAction", "auditCategory")).data
    ?.facets;
  const actorFacets = useLogEvents(without("actor", "actorKind")).data?.facets;
  const resourceFacets = useLogEvents(without("resourceType", "resourceName"))
    .data?.facets;
  const statusCount = (s: string) =>
    resourceFacets?.status.find((f) => f.value === s)?.count;

  const eventGroups = paneGroups(eventFacets?.auditCategoryAction, (cat) => ({
    label: cat,
    anyLabel: `Any ${cat === "MCP" || cat === "LLM" ? cat : cat.toLowerCase()} event`,
    icon: CATEGORY_ICON[cat] ?? ScrollText,
  }));
  const actorGroups = paneGroups(
    actorFacets?.actorByKind,
    (kind) => ({
      label: ACTOR_KIND[kind]?.label ?? kind,
      anyLabel: ACTOR_KIND[kind]?.any ?? `Any ${kind}`,
      icon: ACTOR_KIND[kind]?.icon ?? User,
    }),
    (kind, name) => actorMark(kind, name),
    (kind) => ACTOR_KIND[kind]?.order ?? 9,
  );
  const resourceGroups = paneGroups(resourceFacets?.resourceName, (t) => ({
    label: RESOURCE[t]?.[0] ?? humanize(t),
    anyLabel: `Any ${RESOURCE[t]?.[1] ?? humanize(t).toLowerCase()}`,
    icon: RESOURCE_ICON[t] ?? auditResourceIcon(camel(t)),
  }));

  return (
    <>
      <PanePicker
        name="Event"
        idleLabel="All events"
        allLabel="All events"
        searchLabel="Search events"
        itemNoun={["event type", "event types"]}
        groups={eventGroups}
        value={{ group: get("auditCategory"), item: get("auditAction") }}
        onChange={(v) =>
          set({
            auditAction: v.item,
            auditCategory: v.item ? undefined : v.group,
          })
        }
        compact={compact}
      />
      <PanePicker
        name="Actor"
        idleLabel="All actors"
        allLabel="Any actor"
        searchLabel="Search actors"
        itemNoun={["actor", "actors"]}
        groups={actorGroups}
        value={{ group: get("actorKind"), item: get("actor") }}
        onChange={(v) => set({ actorKind: v.group, actor: v.item })}
        compact={compact}
      />
      <PanePicker
        name="Resource"
        idleLabel="All resources"
        allLabel="All resources"
        searchLabel="Search resources"
        itemNoun={["resource", "resources"]}
        groups={resourceGroups}
        value={{ group: get("resourceType"), item: get("resourceName") }}
        onChange={(v) => set({ resourceType: v.group, resourceName: v.item })}
        compact={compact}
      />
      <FilterChip
        name="Outcome"
        idleLabel="All outcomes"
        allLabel="All outcomes"
        value={get("outcome")}
        options={[
          {
            value: "success",
            label: "Success",
            description: "The request went through",
            count: statusCount("ok"),
            mark: <ActionIcon icon={CircleCheck} tone="text-emerald-500" />,
          },
          {
            value: "failure",
            label: "Failure",
            description: "Denied or failed",
            count: statusCount("error"),
            mark: <ActionIcon icon={CircleX} tone="text-red-500" />,
          },
        ]}
        onChange={(v) => set({ outcome: v })}
      />
    </>
  );
}

/** "group::item" facet pairs into two-pane groups, biggest first. */
function paneGroups(
  pairs: LogFacetCount[] | undefined,
  describe: (group: string) => Pick<PaneGroup, "label" | "anyLabel" | "icon">,
  leading?: (group: string, item: string) => ReactNode,
  order?: (group: string) => number,
): PaneGroup[] {
  const map = new Map<string, PaneGroup>();
  for (const f of pairs ?? []) {
    const [g, item] = splitPair(f.value);
    let group = map.get(g);
    if (!group) {
      group = { value: g, count: 0, items: [], ...describe(g) };
      map.set(g, group);
    }
    group.count += f.count;
    group.items.push({
      value: item,
      label: item,
      count: f.count,
      leading: leading?.(g, item),
    });
  }
  return [...map.values()]
    .map((g) => ({
      ...g,
      items: g.items.sort((a, b) => b.count - a.count),
    }))
    .sort(
      (a, b) =>
        (order?.(a.value) ?? 0) - (order?.(b.value) ?? 0) ||
        a.label.localeCompare(b.label),
    );
}

// ===== small pieces =====

/**
 * Facets carry names only; one wide page of the type tells each agent's kind,
 * each model's maker and each person's email. Shared (and cached) by every
 * chip of the type.
 */
function useDirectory(type: LogSource) {
  const { data } = useLogEvents({ sources: [type], hours: 72, limit: 500 });
  const agents = new Map<string, NonNullable<LogEvent["agent"]>>();
  const models = new Map<string, NonNullable<LogEvent["llm"]>["provider"]>();
  const emails = new Map<string, string>();
  for (const e of data?.data ?? []) {
    if (e.agent) agents.set(e.agent.name, e.agent);
    if (e.llm) models.set(e.llm.model, e.llm.provider);
    if (e.actor.email) emails.set(e.actor.name, e.actor.email);
  }
  return { agents, models, emails };
}

function actorMark(kind: string, name: string) {
  if (kind === "user")
    return <PersonAvatar name={name} size={16} ring={false} />;
  if (kind === "agent")
    return <AgentIdenticon seed={name} name={name} variant="agent" size="sm" />;
  return <IconTile icon={ACTOR_KIND[kind]?.icon ?? User} tone="slate" />;
}

/** Today's app option: the client family's icon, or the request source's. */
function ClientOption({ name }: { name: string }) {
  const known = knownClient(name);
  if (known) return <ClientFilterOption client={known} />;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <ClientMark name={name} />
      <span className="truncate">{name}</span>
    </span>
  );
}

function knownClient(name: string) {
  return CLIENT_FILTER_OPTIONS.find(
    (c) => c.label.toLowerCase() === name.toLowerCase(),
  );
}

/** The MCP logs page's server glyph (catalog logo when there is one). */
function ServerMark() {
  return (
    <span className="flex size-5 shrink-0 items-center justify-center rounded-[5px] border border-border/70 bg-gradient-to-b from-background to-muted/70 text-foreground/70">
      <McpCatalogIcon icon={null} size={12} />
    </span>
  );
}

function ActionIcon({ icon: Icon, tone }: { icon: LucideIcon; tone?: string }) {
  return (
    <Icon
      aria-hidden
      className={cn("size-4 shrink-0", tone ?? "text-muted-foreground")}
    />
  );
}

function ClientMark({ name }: { name: string }) {
  const known = knownClient(name);
  if (known) return <ClientIcon client={known} size={16} />;
  // Apps today's filter shows as request sources keep that source's icon.
  const source = CLIENT_SOURCE[name];
  if (source)
    return (
      <span className="flex size-4 shrink-0 items-center justify-center">
        <SourceIcon source={source} />
      </span>
    );
  return <IconTile icon={Laptop} tone="slate" />;
}

function IconTile({
  icon: Icon,
  tone,
}: {
  icon: LucideIcon;
  tone: keyof typeof TILE_TONE;
}) {
  return (
    <span
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-[4px]",
        TILE_TONE[tone],
      )}
    >
      <Icon aria-hidden className="size-2.5" />
    </span>
  );
}

function Dot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("mx-[3px] size-2 shrink-0 rounded-full", className)}
    />
  );
}

function splitPair(value: string): [string, string] {
  const i = value.indexOf("::");
  return i < 0 ? [value, value] : [value.slice(0, i), value.slice(i + 2)];
}

function humanize(value: string) {
  const s = value.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function camel(value: string) {
  return value.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
}

const TILE_TONE = {
  sky: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  violet: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  amber: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  fuchsia: "bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300",
  slate: "bg-muted text-muted-foreground",
};

const AGENT_KIND_HEADING = {
  agent: "Agents",
  mcp_gateway: "MCP gateways",
  llm_proxy: "LLM proxies",
} as const;

const AGENT_KIND_ORDER = { agent: 0, mcp_gateway: 1, llm_proxy: 2 } as const;

const ACTOR_KIND: Record<
  string,
  { label: string; any: string; icon: LucideIcon; order: number }
> = {
  user: { label: "People", any: "Any person", icon: User, order: 0 },
  agent: { label: "Agents", any: "Any agent", icon: BrainCircuit, order: 1 },
  service_account: {
    label: "Service accounts",
    any: "Any service account",
    icon: Bot,
    order: 2,
  },
  system: { label: "System", any: "Any system job", icon: Cpu, order: 3 },
};

const CATEGORY_ICON: Record<string, LucideIcon> = {
  Agents: Bot,
  MCP: Server,
  Guardrails: Shield,
  LLM: Sparkles,
  "Users & access": Users,
  Authentication: LogIn,
  Organization: Building2,
};

/** Resource type → [plural label, singular noun]. */
const RESOURCE: Record<string, [string, string]> = {
  agent: ["Agents", "agent"],
  agent_tool: ["Agent tools", "agent tool"],
  mcp_server: ["MCP servers", "MCP server"],
  openappa_policy: ["Guardrail policies", "guardrail policy"],
  virtual_key: ["Virtual keys", "virtual key"],
  llm_provider_api_key: ["Provider API keys", "provider API key"],
  limit: ["Cost limits", "cost limit"],
  invitation: ["Invitations", "invitation"],
  role: ["Roles", "role"],
  team_member: ["Team members", "team member"],
  session: ["Sessions", "session"],
  api_key: ["API keys", "API key"],
  organization: ["Organization", "organization setting"],
};

const RESOURCE_ICON: Record<string, LucideIcon> = {
  agent: Bot,
  agent_tool: Wrench,
  mcp_server: Server,
  openappa_policy: Shield,
  virtual_key: KeyRound,
  llm_provider_api_key: KeyRound,
  limit: Gauge,
  invitation: Mail,
  role: ShieldCheck,
  team_member: Users,
  session: LogIn,
  api_key: KeyRound,
  organization: Building2,
};

const DECISION = {
  allow: {
    label: "Allowed",
    dot: "bg-emerald-500",
    description: "The call ran",
  },
  deny: {
    label: "Blocked",
    dot: "bg-orange-500",
    description: "Guardrails stopped the call",
  },
  review: {
    label: "Needs approval",
    dot: "bg-amber-500",
    description: "Waited for a person to approve",
  },
} as const;

const CONNECTION: Record<
  string,
  { label: string; description: string; icon: LucideIcon; tone: string }
> = {
  connected: {
    label: "Connected",
    description: "A client opened a session",
    icon: Plug,
    tone: "text-emerald-500",
  },
  first_seen: {
    label: "First seen",
    description: "A client connected for the first time",
    icon: Eye,
    tone: "text-sky-500",
  },
  authorized: {
    label: "Authorized",
    description: "A person granted the client access",
    icon: ShieldCheck,
    tone: "text-violet-500",
  },
  token_refreshed: {
    label: "Token refreshed",
    description: "The client renewed its access token",
    icon: RefreshCw,
    tone: "text-muted-foreground",
  },
  disconnected: {
    label: "Disconnected",
    description: "The session ended",
    icon: Unplug,
    tone: "text-zinc-500",
  },
};

const PROVIDER_LABEL: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Google Gemini",
  bedrock: "AWS Bedrock",
};

/** Apps the filter shows as request sources rather than client apps. */
const CLIENT_SOURCE: Record<string, InteractionSource> = {
  Slack: "chatops:slack",
  "Archestra Chat": "chat",
};

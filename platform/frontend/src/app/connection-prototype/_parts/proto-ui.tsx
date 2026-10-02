"use client";

// Low-fidelity building blocks shared by Connect prototypes. Nothing here
// talks to the backend: buttons only move local state, so variants can be
// stitched together quickly and thrown away just as quickly.

import {
  Check,
  CircleDashed,
  Loader2,
  MessageSquareText,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useState } from "react";
import { ClientPicker } from "@/app/connection/client-grid";
import { ClientIcon } from "@/app/connection/client-icon";
import { CONNECT_CLIENTS, type ConnectClient } from "@/app/connection/clients";
import { TerminalBlock } from "@/app/connection/terminal-block";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils/tailwind";
import type { ConnectScenario, MockServer } from "./scenarios";

export const MOCK_GATEWAY_URL = "https://archestra.example.com/v1/mcp/sam";

/** Mock list until the real ArchAPPA-supported set is confirmed. */
export const GUARDRAIL_CLIENT_IDS = [
  "claude-code",
  "codex",
  "cursor",
  "opencode",
  "copilot-cli",
];

export function getClient(id: string): ConnectClient {
  return (
    CONNECT_CLIENTS.find((client) => client.id === id) ?? CONNECT_CLIENTS[0]
  );
}

export function hasGuardrails(clientId: string) {
  return GUARDRAIL_CLIENT_IDS.includes(clientId);
}

export function countTools(scenario: ConnectScenario) {
  return scenario.servers.reduce(
    (total, server) => total + server.toolCount,
    0,
  );
}

// ---------------------------------------------------------------------------
// Layout

export function ProtoPage({
  title,
  subtitle,
  children,
  width = "default",
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  width?: "default" | "wide";
}) {
  return (
    <div
      className={cn(
        "mx-auto flex w-full flex-col gap-6 px-6 py-8",
        width === "wide" ? "max-w-6xl" : "max-w-4xl",
      )}
    >
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle ? <p className="text-muted-foreground">{subtitle}</p> : null}
      </div>
      {children}
    </div>
  );
}

export function ProtoSection({
  step,
  title,
  description,
  children,
  muted = false,
}: {
  step?: number;
  title: string;
  description?: React.ReactNode;
  children?: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <section className={cn("flex gap-4", muted && "opacity-50")}>
      {step ? (
        <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
          {step}
        </div>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div>
          <h2 className="text-lg font-semibold">{title}</h2>
          {description ? (
            <p className="text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {children}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Value preview (avenue A)

function ServerMark({ server }: { server: MockServer }) {
  return (
    <div
      title={server.name}
      className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted text-sm font-semibold"
    >
      {server.name.slice(0, 1)}
    </div>
  );
}

export function ServerLogos({
  scenario,
  limit = 8,
}: {
  scenario: ConnectScenario;
  limit?: number;
}) {
  const extra = scenario.servers.length - limit;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {scenario.servers.slice(0, limit).map((server) => (
        <div key={server.id} className="flex items-center gap-2">
          <ServerMark server={server} />
          <span className="text-sm">{server.name}</span>
        </div>
      ))}
      {extra > 0 ? (
        <Badge variant="secondary">+{extra.toLocaleString()} more</Badge>
      ) : null}
    </div>
  );
}

export function ValueCounts({ scenario }: { scenario: ConnectScenario }) {
  const stats = [
    { label: "integrations", value: scenario.servers.length },
    { label: "tools", value: countTools(scenario) },
    { label: "skills", value: scenario.skills.length },
  ];
  return (
    <div className="flex gap-6">
      {stats.map((stat) => (
        <div key={stat.label}>
          <div className="text-2xl font-semibold">
            {stat.value.toLocaleString()}
          </div>
          <div className="text-xs text-muted-foreground">{stat.label}</div>
        </div>
      ))}
    </div>
  );
}

export function ExampleAsks({
  scenario,
  title = "Things you could ask",
}: {
  scenario: ConnectScenario;
  title?: string;
}) {
  const asks = scenario.servers
    .filter((server) => server.exampleAsk)
    .slice(0, 3);
  if (asks.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </div>
      {asks.map((server) => (
        <div
          key={server.id}
          className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm"
        >
          <MessageSquareText className="size-4 text-muted-foreground" />
          <span className="flex-1">“{server.exampleAsk}”</span>
          <Badge variant="outline">{server.name}</Badge>
        </div>
      ))}
    </div>
  );
}

export function EmptyGatewayNotice() {
  return (
    <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
      You don't have access to any integrations yet. Ask your admin to share
      one, or connect anyway and tools will appear as they're added.
    </div>
  );
}

// ---------------------------------------------------------------------------
// Client picking (avenue C)

export function ProtoClientGrid({
  selected,
  onSelect,
  clientIds,
}: {
  selected: string | null;
  onSelect: (id: string) => void;
  clientIds?: string[];
}) {
  const clients = clientIds
    ? CONNECT_CLIENTS.filter((client) => clientIds.includes(client.id))
    : CONNECT_CLIENTS;
  return (
    <ClientPicker clients={clients} selected={selected} onSelect={onSelect} />
  );
}

export function ClientLine({
  clientId,
  children,
}: {
  clientId: string;
  children?: React.ReactNode;
}) {
  const client = getClient(clientId);
  return (
    <div className="flex items-center gap-3">
      <ClientIcon client={client} size={32} />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold">{client.label}</div>
        <div className="text-xs text-muted-foreground">{client.sub}</div>
      </div>
      {children}
    </div>
  );
}

export function GuardrailBadge({ clientId }: { clientId: string }) {
  return hasGuardrails(clientId) ? (
    <Badge variant="secondary" className="gap-1">
      <ShieldCheck className="size-3" />
      <span>Guardrails</span>
    </Badge>
  ) : (
    <Badge variant="outline">
      <span>No guardrails yet</span>
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Install routes (avenue B)

export type InstallRoute = "native" | "script" | "prompt" | "hybrid";

export const INSTALL_ROUTES: {
  id: InstallRoute;
  label: string;
  blurb: string;
}[] = [
  {
    id: "native",
    label: "Native command",
    blurb: "Your agent's own MCP command. Gateway only, nothing else changes.",
  },
  {
    id: "script",
    label: "Install script",
    blurb: "One script installs the gateway, skills and model routing.",
  },
  {
    id: "prompt",
    label: "Ask your agent",
    blurb: "Paste a prompt and your agent runs the setup for you.",
  },
  {
    id: "hybrid",
    label: "Hybrid",
    blurb: "A script that uses your agent's native commands under the hood.",
  },
];

export function installCommand(route: InstallRoute, clientId: string) {
  const client = getClient(clientId);
  switch (route) {
    case "native":
      if (clientId === "codex") {
        return `codex mcp add archestra --url ${MOCK_GATEWAY_URL}`;
      }
      if (clientId === "claude-code") {
        return `claude mcp add --transport http archestra ${MOCK_GATEWAY_URL}`;
      }
      return `{ "mcpServers": { "archestra": { "url": "${MOCK_GATEWAY_URL}" } } }`;
    case "script":
      return `curl -fsSL https://archestra.example.com/install.sh | sh -s -- --client ${clientId}`;
    case "prompt":
      return `Read https://archestra.example.com/connect.md?client=${clientId} and connect ${client.label}.`;
    case "hybrid":
      return `npx @archestra/connect ${clientId}`;
  }
}

export function CommandBlock({ code }: { code: string }) {
  return <TerminalBlock code={code} />;
}

// ---------------------------------------------------------------------------
// Install plan (avenue D)

export interface PlanPiece {
  id: string;
  title: string;
  summary: string;
  changes: string;
  context: string;
  cost: string;
  undo: string;
  /** "org" pieces are set by the admin and cannot be toggled by users. */
  control: "user" | "org";
}

export const PLAN_PIECES: PlanPiece[] = [
  {
    id: "gateway",
    title: "MCP gateway",
    summary: "Your tools, through one endpoint.",
    changes: "Adds one MCP server entry to your agent's config.",
    context: "Tool names load on demand in discovery mode.",
    cost: "No model cost.",
    undo: "Revoke here, or remove the archestra entry.",
    control: "org",
  },
  {
    id: "skills",
    title: "Skills",
    summary: "Team playbooks your agent can follow.",
    changes: "Adds a skills folder your agent reads.",
    context: "Only descriptions load until a skill is used.",
    cost: "No model cost.",
    undo: "Delete the folder or untick here.",
    control: "user",
  },
  {
    id: "proxy",
    title: "Route models through Archestra",
    summary: "Model calls go through your company's account.",
    changes: "Sets a base URL environment variable for your agent.",
    context: "No change.",
    cost: "Billed to your company, not you.",
    undo: "Unset the variable or untick here.",
    control: "user",
  },
  {
    id: "guardrails",
    title: "Guardrails",
    summary: "Your company's policies apply to what the agent does.",
    changes: "Adds a hook your agent runs before each tool call.",
    context: "No change.",
    cost: "No model cost.",
    undo: "Managed by your admin.",
    control: "org",
  },
];

function PlanFacts({ piece }: { piece: PlanPiece }) {
  const facts = [
    ["On your machine", piece.changes],
    ["Context", piece.context],
    ["Who pays", piece.cost],
    ["Undo", piece.undo],
  ];
  return (
    <dl className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-1 text-xs">
      {facts.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function InstallPlan({
  layout,
  toggles,
  pieces = PLAN_PIECES,
}: {
  layout: "expanded" | "collapsed";
  toggles: boolean;
  pieces?: PlanPiece[];
}) {
  const [enabled, setEnabled] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(pieces.map((piece) => [piece.id, true])),
  );
  const [open, setOpen] = useState<string | null>(null);

  return (
    <div className="divide-y rounded-lg border bg-card">
      {pieces.map((piece) => {
        const expanded = layout === "expanded" || open === piece.id;
        return (
          <div key={piece.id} className="flex flex-col gap-2 p-3">
            <div className="flex items-center gap-3">
              {enabled[piece.id] ? (
                <Check className="size-4 text-emerald-600" />
              ) : (
                <CircleDashed className="size-4 text-muted-foreground" />
              )}
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{piece.title}</div>
                <div className="text-xs text-muted-foreground">
                  {piece.summary}
                </div>
              </div>
              {layout === "collapsed" ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setOpen(open === piece.id ? null : piece.id)}
                >
                  <span>{expanded ? "Hide" : "Details"}</span>
                </Button>
              ) : null}
              {toggles && piece.control === "user" ? (
                <Switch
                  checked={enabled[piece.id]}
                  onCheckedChange={(checked) =>
                    setEnabled((prev) => ({ ...prev, [piece.id]: checked }))
                  }
                  aria-label={`Include ${piece.title}`}
                />
              ) : (
                <Badge variant="outline">
                  <span>
                    {piece.control === "org" ? "Set by your org" : "Included"}
                  </span>
                </Badge>
              )}
            </div>
            {expanded ? (
              <div className="pl-7">
                <PlanFacts piece={piece} />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// After install (avenues F and G)

/** Fakes the "waiting for your first tool call" moment. */
export function ListeningCard({
  clientId,
  scenario,
  delayMs = 3500,
}: {
  clientId: string;
  scenario: ConnectScenario;
  delayMs?: number;
}) {
  const [verified, setVerified] = useState(false);
  useEffect(() => {
    setVerified(false);
    const timer = setTimeout(() => setVerified(true), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs]);
  const client = getClient(clientId);
  const firstServer = scenario.servers[0];

  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-lg border p-4 transition-colors",
        verified && "border-emerald-500/50 bg-emerald-500/5",
      )}
    >
      <div className="flex items-center gap-3">
        <ClientIcon client={client} size={32} />
        {verified ? (
          <div className="flex-1">
            <div className="font-medium">{client.label} is connected</div>
            <div className="text-sm text-muted-foreground">
              Your agent just called{" "}
              <code className="rounded bg-muted px-1">
                {(firstServer?.id ?? "archestra").replace("-", "_")}.list
              </code>
            </div>
          </div>
        ) : (
          <div className="flex-1">
            <div className="flex items-center gap-2 font-medium">
              <Loader2 className="size-4 animate-spin" />
              <span>Waiting for {client.label}…</span>
            </div>
            <div className="text-sm text-muted-foreground">
              Ask your agent anything that uses a tool. We'll flip to connected
              the moment it does.
            </div>
          </div>
        )}
      </div>
      {verified ? <ExampleAsks scenario={scenario} title="Try next" /> : null}
    </div>
  );
}

export const STATUS_LABEL: Record<
  ConnectScenario["connectedAgents"][number]["status"],
  string
> = {
  "instructions-ready": "Instructions ready",
  authorized: "Authorized, no tool call yet",
  verified: "Verified",
};

export function relativeDay(iso: string | null) {
  if (!iso) return "never";
  const days = Math.round(
    (Date.parse("2026-10-02T18:00:00Z") - Date.parse(iso)) / 86_400_000,
  );
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

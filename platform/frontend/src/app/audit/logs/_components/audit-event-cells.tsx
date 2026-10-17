"use client";

import {
  AppWindow,
  Blocks,
  Bot,
  Building2,
  CalendarClock,
  Database,
  FileText,
  Fingerprint,
  Gauge,
  Globe,
  KeyRound,
  LogIn,
  type LucideIcon,
  MessageSquare,
  Plug,
  Server,
  Shield,
  ShieldBan,
  Sparkles,
  User,
  UserCog,
  Users,
  Wrench,
  X,
} from "lucide-react";
import { PersonAvatar } from "@/app/llm/logs/_parts/hue-avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import type { AuditLog } from "@/lib/audit-log/audit-log.query";
import { formatCompactRelativeTime, formatDate } from "@/lib/utils/date-time";
import { cn } from "@/lib/utils/tailwind";
import { type AuditActor, describeAuditActor } from "./audit-actor-cell";
import {
  formatAction,
  formatResourceType,
  OUTCOME_LABEL,
  resourceDisplayName,
} from "./audit-log-action-labels";

type AuditEventRow = Omit<AuditLog, "action"> & { action: string };

/**
 * What happened to what: the resource type's tile with the actor pinned to
 * its corner, then the resource over "Updated · Agent". Only a failure or a
 * denial colors the row.
 */
export function AuditEventCell({ event }: { event: AuditEventRow }) {
  const typeLabel = formatResourceType(event.resourceType ?? "");
  const name =
    event.resourceType && LIST_NAME_RESOURCE_TYPES.has(event.resourceType)
      ? resourceDisplayName(event)
      : null;
  const failed = event.outcome !== "success";
  const OutcomeIcon = event.outcome === "denied" ? ShieldBan : X;
  const actor = describeAuditActor(event);

  return (
    <div className="flex min-w-0 items-center gap-3.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <UnstyledButton
            aria-label={`${OUTCOME_LABEL[event.outcome]}: ${formatAction(event.action)} by ${actor.name}`}
            className="relative block size-9 shrink-0 cursor-default"
          >
            <ResourceTile type={event.resourceType} failed={failed} />
            <span className="absolute -right-1.5 -bottom-1.5 flex">
              <ActorBadge actor={actor} />
            </span>
          </UnstyledButton>
        </TooltipTrigger>
        <TooltipContent className="px-2 py-1.5">
          <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 tabular-nums">
            <dt className="text-muted-foreground">Event</dt>
            <dd className="text-right font-mono text-[11px]">{event.action}</dd>
            <dt className="text-muted-foreground">Outcome</dt>
            <dd className="text-right">{OUTCOME_LABEL[event.outcome]}</dd>
            <dt className="text-muted-foreground">By</dt>
            <dd className="text-right">{actor.name}</dd>
          </dl>
        </TooltipContent>
      </Tooltip>
      <div className="min-w-0 flex-1">
        <div
          className="truncate text-sm leading-5 font-medium"
          title={name ?? undefined}
        >
          {name ?? typeLabel}
        </div>
        <div className="flex h-4 min-w-0 items-center gap-1 text-xs leading-4 text-muted-foreground">
          {failed ? (
            <>
              <span className="flex shrink-0 items-center gap-0.5 font-medium text-destructive">
                <OutcomeIcon className="size-3" aria-hidden="true" />
                {OUTCOME_LABEL[event.outcome]}
              </span>
              <Dot />
            </>
          ) : null}
          <span className="shrink-0 text-foreground/80">
            {verbOf(event.action, typeLabel)}
          </span>
          {name ? (
            <>
              <Dot />
              <span className="truncate">{typeLabel}</span>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * The HTTP method and status that carried the change. Client network details
 * (route, source IP, request ID) stay in the tooltip and the detail dialog.
 */
export function AuditRequestCell({ event }: { event: AuditEventRow }) {
  if (!event.httpMethod) {
    return <div className="text-right text-xs text-muted-foreground">—</div>;
  }
  const isError = (event.httpStatus ?? 0) >= 400;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <UnstyledButton className="ml-auto block cursor-default text-right tabular-nums">
          <span className="block text-sm leading-5 font-medium whitespace-nowrap">
            {event.httpMethod}
          </span>
          <span
            className={cn(
              "block text-xs leading-4 whitespace-nowrap",
              isError ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {event.httpStatus ?? "—"}
          </span>
        </UnstyledButton>
      </TooltipTrigger>
      <TooltipContent className="px-2 py-1.5">
        <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 tabular-nums">
          <dt className="text-muted-foreground">Route</dt>
          <dd className="text-right font-mono text-[11px]">
            {event.httpRoute ?? event.httpPath ?? "—"}
          </dd>
          <dt className="text-muted-foreground">Status</dt>
          <dd className="text-right">{event.httpStatus ?? "—"}</dd>
          <dt className="text-muted-foreground">Source IP</dt>
          <dd className="text-right">{event.sourceIp ?? "—"}</dd>
        </dl>
      </TooltipContent>
    </Tooltip>
  );
}

/** How long ago the event happened, over its clock time. */
export function AuditTimeCell({ event }: { event: AuditEventRow }) {
  const at = event.occurredAt ?? event.createdAt;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <UnstyledButton className="ml-auto block cursor-default text-right tabular-nums">
          <time dateTime={at} className="block text-sm leading-5">
            {formatCompactRelativeTime(at)}
          </time>
          <span className="block text-xs leading-4 whitespace-nowrap text-muted-foreground">
            {formatDate({ date: at, dateFormat: "MMM d · HH:mm" })}
          </span>
        </UnstyledButton>
      </TooltipTrigger>
      <TooltipContent className="px-2 py-1.5">
        <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 tabular-nums">
          <dt className="text-muted-foreground">Occurred</dt>
          <dd className="text-right">{formatDate({ date: at })}</dd>
          <dt className="text-muted-foreground">Recorded</dt>
          <dd className="text-right">
            {formatDate({ date: event.createdAt })}
          </dd>
        </dl>
      </TooltipContent>
    </Tooltip>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

// The high-signal types whose names render in the list. Every other type keeps
// a bare type label; its full identity lives in the detail dialog.
const LIST_NAME_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  "agent",
  "app",
  "environment",
  "mcpServer",
  "role",
  "skill",
  "team",
]);

function ActorBadge({ actor }: { actor: AuditActor }) {
  if (actor.kind === "person") {
    return <PersonAvatar name={actor.name} size={18} />;
  }
  const Icon = actor.icon;
  return (
    <span className="flex size-[18px] items-center justify-center rounded-full bg-muted text-muted-foreground ring-2 ring-background">
      <Icon className="size-2.5" strokeWidth={2.25} aria-hidden="true" />
    </span>
  );
}

function ResourceTile({
  type,
  failed,
}: {
  type: string | null | undefined;
  failed: boolean;
}) {
  const Icon = (type && RESOURCE_ICONS[type]) || Blocks;
  return (
    <span
      className={cn(
        "flex size-9 items-center justify-center rounded-[9px] border bg-gradient-to-b from-background to-muted/70 text-foreground/70 [&_svg]:size-4",
        failed ? "border-destructive/40 text-destructive" : "border-border/70",
      )}
    >
      <Icon aria-hidden="true" />
    </span>
  );
}

/**
 * "Agent updated" → "Updated", "Member role changed" → "Role changed": the
 * resource type is already on the line, so the verb carries only the action.
 */
function verbOf(action: string, typeLabel: string): string {
  const label = formatAction(action);
  const actionNoun = action
    .split(".")[0]
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();
  for (const prefix of [typeLabel, actionNoun]) {
    if (prefix && label.toLowerCase().startsWith(`${prefix.toLowerCase()} `)) {
      const rest = label.slice(prefix.length + 1);
      return rest.charAt(0).toUpperCase() + rest.slice(1);
    }
  }
  return label;
}

function Dot() {
  return (
    <span aria-hidden="true" className="shrink-0 text-muted-foreground/50">
      ·
    </span>
  );
}

const RESOURCE_ICONS: Record<string, LucideIcon> = {
  agent: Bot,
  agentRun: Bot,
  agentTool: Wrench,
  apiKey: KeyRound,
  app: AppWindow,
  auth: LogIn,
  chatOpsBinding: MessageSquare,
  chatOpsConfig: MessageSquare,
  clientConnection: Plug,
  connectedClient: Plug,
  connector: Plug,
  credential: KeyRound,
  defaultUserLimit: Gauge,
  environment: Globe,
  githubPat: KeyRound,
  identityProvider: Fingerprint,
  internalMcpCatalog: Server,
  invitation: Users,
  knowledgeBase: Database,
  knowledgeDirectory: Database,
  knowledgeFile: FileText,
  limit: Gauge,
  llmModel: Sparkles,
  llmOauthClient: KeyRound,
  llmProviderApiKey: KeyRound,
  llmProxy: Server,
  mcpOauthClient: KeyRound,
  mcpServer: Server,
  member: UserCog,
  oauthClient: KeyRound,
  organization: Building2,
  plugin: Blocks,
  role: Shield,
  runtimeCredential: KeyRound,
  scheduleTrigger: CalendarClock,
  serviceAccount: Bot,
  skill: Sparkles,
  team: Users,
  teamToken: KeyRound,
  user: User,
  userToken: KeyRound,
  virtualApiKey: KeyRound,
};

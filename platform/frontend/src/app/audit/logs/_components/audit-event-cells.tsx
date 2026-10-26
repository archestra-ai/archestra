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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import type { AuditLog } from "@/lib/audit-log/audit-log.query";
import { formatCompactRelativeTime, formatDate } from "@/lib/utils/date-time";
import { cn } from "@/lib/utils/tailwind";
import {
  formatAction,
  formatResourceType,
  OUTCOME_LABEL,
  resourceDisplayName,
} from "./audit-log-action-labels";

type AuditEventRow = Omit<AuditLog, "action"> & { action: string };

/**
 * What happened, then to what: "Agent updated" over "Support bot · Agent".
 * The actor has its own column, so the tile carries only the resource type;
 * only a failure or a denial colors it.
 */
export function AuditEventCell({ event }: { event: AuditEventRow }) {
  const typeLabel = formatResourceType(event.resourceType ?? "");
  const name =
    event.resourceType && LIST_NAME_RESOURCE_TYPES.has(event.resourceType)
      ? resourceDisplayName(event)
      : null;
  const failed = event.outcome !== "success";
  const action = formatAction(event.action);

  return (
    <div className="flex min-w-0 items-center gap-3">
      <Tooltip>
        <TooltipTrigger asChild>
          <UnstyledButton
            aria-label={`${action}: ${event.action}`}
            className="block shrink-0 cursor-default"
          >
            <ResourceTile type={event.resourceType} failed={failed} />
          </UnstyledButton>
        </TooltipTrigger>
        <TooltipContent className="font-mono text-[11px]">
          {event.action}
        </TooltipContent>
      </Tooltip>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm leading-5 font-medium" title={action}>
          {action}
        </div>
        {/* One inline run that truncates as a whole, so a narrow column cuts
            the line short instead of pushing it into the next cell. */}
        <div
          className="h-4 truncate text-xs leading-4 text-muted-foreground"
          title={name ?? undefined}
        >
          {name ? (
            <>
              <span className="text-foreground/80">{name}</span> <Dot />{" "}
              {typeLabel}
            </>
          ) : (
            typeLabel
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Whether the change went through, over the HTTP request that carried it.
 * Background changes have no request, and say so instead of a bare dash.
 */
export function AuditStatusCell({ event }: { event: AuditEventRow }) {
  const failed = event.outcome !== "success";
  const OutcomeIcon = event.outcome === "denied" ? ShieldBan : X;
  const isError = (event.httpStatus ?? 0) >= 400;
  const outcome = (
    <span
      className={cn(
        "flex items-center justify-end gap-1.5 text-sm leading-5 whitespace-nowrap",
        failed ? "font-medium text-destructive" : "text-foreground",
      )}
    >
      {failed ? (
        <OutcomeIcon className="size-3.5" aria-hidden="true" />
      ) : (
        <span
          aria-hidden="true"
          className="size-1.5 rounded-full bg-emerald-500"
        />
      )}
      {OUTCOME_LABEL[event.outcome]}
    </span>
  );
  if (!event.httpMethod) {
    return (
      <div className="text-right">
        {outcome}
        <span className="block text-xs leading-4 whitespace-nowrap text-muted-foreground">
          Background
        </span>
      </div>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <UnstyledButton className="ml-auto block cursor-default text-right tabular-nums">
          {outcome}
          <span
            className={cn(
              "block text-xs leading-4 whitespace-nowrap",
              isError ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {event.httpMethod} · {event.httpStatus ?? "—"}
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
  userLimitUsage: Gauge,
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

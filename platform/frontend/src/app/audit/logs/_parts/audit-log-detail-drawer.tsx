"use client";

import {
  Check,
  ChevronDown,
  ChevronUp,
  Laptop,
  Link2,
  ShieldBan,
  Smartphone,
  VenetianMask,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { UAParser } from "ua-parser-js";
import { AgentIdenticon, PersonAvatar } from "@/app/llm/logs/_parts/hue-avatar";
import { CopyButton } from "@/components/copy-button";
import { JsonCodeBlock } from "@/components/json-code-block";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { AuditLog } from "@/lib/audit-log/audit-log.query";
import { copyToClipboard } from "@/lib/clipboard";
import {
  formatCompactRelativeTime,
  formatDate,
  formatRelativeTimeFromNow,
} from "@/lib/utils/date-time";
import { cn } from "@/lib/utils/tailwind";
import { describeAuditActor } from "./audit-actor-cell";
import { auditResourceIcon } from "./audit-event-taxonomy";
import {
  formatAction,
  formatResourceType,
  OUTCOME_LABEL,
  resourceDisplayName,
} from "./audit-log-action-labels";
import {
  AuditLogDiffView,
  summarizeAuditDiffHints,
} from "./audit-log-diff-view";

/**
 * One audit event in a right drawer built for walking the trail: the header
 * steps through the table's rows (buttons, ↑/↓ or j/k) and carries the
 * event's identity; the body splits into Overview, Changes and Raw.
 */
export function AuditLogDetailDrawer({
  event,
  shareUrl,
  onClose,
  events,
  onOpenEvent,
}: {
  /** null = closed. */
  event: AuditLog | null;
  /** Full shareable URL for the open event. */
  shareUrl: string;
  onClose: () => void;
  /** The table's rows in display order, for previous/next. */
  events: AuditLog[];
  onOpenEvent: (event: AuditLog) => void;
}) {
  // Keep the last event on screen while the sheet animates out.
  const [shown, setShown] = useState<AuditLog | null>(event);
  if (event !== null && event !== shown) setShown(event);
  // A tab the investigator picked sticks while they step through events,
  // and resets when the drawer closes.
  const [pickedTab, setPickedTab] = useState<DrawerTab | null>(null);
  if (event === null && pickedTab !== null) setPickedTab(null);

  const current = event ?? shown;
  const index = current ? events.findIndex((e) => e.id === current.id) : -1;
  const prev = index > 0 ? events[index - 1] : undefined;
  const next =
    index >= 0 && index < events.length - 1 ? events[index + 1] : undefined;

  useEffect(() => {
    if (event === null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      const target =
        e.key === "ArrowDown" || e.key === "j"
          ? next
          : e.key === "ArrowUp" || e.key === "k"
            ? prev
            : undefined;
      if (!target) return;
      e.preventDefault();
      onOpenEvent(target);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [event, next, prev, onOpenEvent]);

  return (
    <Sheet
      open={event !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        side="right"
        // The header carries its own close button, so the sheet's built-in
        // one (its last child) is hidden.
        className="w-full gap-0 p-0 sm:max-w-[720px] [&>button:last-child]:hidden"
        // Focusing the first control would pop the Previous tooltip on open.
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {current && (
          <DrawerBody
            event={current}
            shareUrl={shareUrl}
            position={index >= 0 ? { index, total: events.length } : null}
            prev={prev}
            next={next}
            onOpenEvent={onOpenEvent}
            tab={pickedTab ?? defaultTab(current)}
            onTabChange={setPickedTab}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

type DrawerTab = "overview" | "changes" | "raw";

type Snapshot = Record<string, unknown> | null;

const METADATA_KEYS = new Set(["updatedAt", "createdAt"]);

const TAB_TRIGGER_CLASS =
  "relative h-full flex-none rounded-none border-0 px-0 text-sm font-medium text-muted-foreground shadow-none after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full hover:text-foreground data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none data-[state=active]:after:bg-foreground dark:text-muted-foreground dark:data-[state=active]:border-transparent dark:data-[state=active]:bg-transparent dark:data-[state=active]:text-foreground";

function DrawerBody({
  event,
  shareUrl,
  position,
  prev,
  next,
  onOpenEvent,
  tab,
  onTabChange,
}: {
  event: AuditLog;
  shareUrl: string;
  position: { index: number; total: number } | null;
  prev: AuditLog | undefined;
  next: AuditLog | undefined;
  onOpenEvent: (event: AuditLog) => void;
  tab: DrawerTab;
  onTabChange: (tab: DrawerTab) => void;
}) {
  const before = (event.before ?? null) as Snapshot;
  const after = (event.after ?? null) as Snapshot;
  const changedCount = useMemo(
    () => countChangedFields(before, after),
    [before, after],
  );

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => onTabChange(value as DrawerTab)}
      className="flex min-h-0 flex-1 flex-col gap-0"
    >
      <header className="shrink-0 border-b">
        <div className="flex h-12 items-center gap-1 px-2 sm:px-4">
          <NavButton
            label="Previous event"
            keys={["↑", "K"]}
            target={prev}
            onOpenEvent={onOpenEvent}
          >
            <ChevronUp />
          </NavButton>
          <NavButton
            label="Next event"
            keys={["↓", "J"]}
            target={next}
            onOpenEvent={onOpenEvent}
          >
            <ChevronDown />
          </NavButton>
          {position && (
            <span className="ml-1.5 text-xs text-muted-foreground tabular-nums">
              {position.index + 1} of {position.total}
            </span>
          )}
          <div className="ml-auto flex items-center gap-0.5">
            <CopyLinkButton url={shareUrl} />
            <Tooltip>
              <TooltipTrigger asChild>
                <SheetClose asChild>
                  <Button variant="ghost" size="icon-sm" aria-label="Close">
                    <X />
                  </Button>
                </SheetClose>
              </TooltipTrigger>
              <TooltipContent>
                <span className="flex items-center gap-1.5">
                  Close <Kbd>Esc</Kbd>
                </span>
              </TooltipContent>
            </Tooltip>
          </div>
        </div>

        <TitleRow event={event} />

        <TabsList
          aria-label="Event view"
          className="h-10 w-full justify-start gap-5 rounded-none bg-transparent p-0 px-4 sm:px-6"
        >
          <TabsTrigger value="overview" className={TAB_TRIGGER_CLASS}>
            Overview
          </TabsTrigger>
          <TabsTrigger value="changes" className={TAB_TRIGGER_CLASS}>
            Changes
            {changedCount > 0 && (
              <span className="rounded-full bg-muted px-1.5 text-[11px] leading-4 font-medium text-muted-foreground tabular-nums">
                {changedCount}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="raw" className={TAB_TRIGGER_CLASS}>
            Raw
          </TabsTrigger>
        </TabsList>
      </header>

      {/* Keyed by event so stepping through the trail starts at the top. */}
      <div
        key={event.id}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 sm:px-6"
      >
        <TabsContent value="overview">
          <OverviewTab event={event} />
        </TabsContent>
        <TabsContent value="changes" className="space-y-3">
          <ChangesSummary before={before} after={after} count={changedCount} />
          <AuditLogDiffView before={before} after={after} />
        </TabsContent>
        <TabsContent value="raw">
          <JsonCodeBlock value={event} maxHeightClassName="" />
        </TabsContent>
      </div>
    </Tabs>
  );
}

function TitleRow({ event }: { event: AuditLog }) {
  const failed = event.outcome !== "success";
  const Icon = auditResourceIcon(event.resourceType);
  const OutcomeIcon = event.outcome === "denied" ? ShieldBan : X;
  const name = resourceDisplayName(event);
  const typeLabel = event.resourceType
    ? formatResourceType(event.resourceType)
    : null;
  const at = event.occurredAt ?? event.createdAt;

  return (
    <div className="flex items-start gap-3 px-4 pt-3 pb-2 sm:px-6">
      <span
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-[9px] border bg-gradient-to-b from-background to-muted/70 text-foreground/70 [&_svg]:size-4",
          failed
            ? "border-destructive/40 text-destructive"
            : "border-border/70",
        )}
      >
        <Icon aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <SheetTitle className="truncate text-base leading-5">
          {formatAction(event.action)}
        </SheetTitle>
        <SheetDescription className="mt-0.5 truncate text-xs leading-4">
          {name ? (
            <>
              <span className="text-foreground/80">{name}</span>
              {typeLabel && <> · {typeLabel}</>}
            </>
          ) : (
            (typeLabel ?? event.action)
          )}
        </SheetDescription>
      </div>
      <div className="shrink-0 text-right">
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
        <time
          dateTime={at}
          title={formatDate({ date: at })}
          className="block text-xs leading-4 whitespace-nowrap text-muted-foreground tabular-nums"
        >
          {formatCompactRelativeTime(at)}
        </time>
      </div>
    </div>
  );
}

function OverviewTab({ event }: { event: AuditLog }) {
  const at = event.occurredAt ?? event.createdAt;

  return (
    <dl className="divide-y">
      <Row label="Actor">
        <ActorValue event={event} />
      </Row>
      <Row label="Resource">
        <ResourceValue event={event} />
      </Row>
      <Row label="Request">
        <RequestValue event={event} />
      </Row>
      <Row label="Client">
        <ClientValue event={event} />
      </Row>
      <Row label="When">
        <div className="space-y-0.5">
          <div className="tabular-nums">
            {formatDate({ date: at, dateFormat: "MMM d, yyyy · HH:mm:ss" })}
          </div>
          <div className="text-xs text-muted-foreground">
            {formatRelativeTimeFromNow(at)}
          </div>
        </div>
      </Row>
      <Row label="Event ID">
        <IdLine value={event.id} />
      </Row>
    </dl>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 py-3 first:pt-0 last:pb-0 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-sm text-muted-foreground sm:leading-6">{label}</dt>
      <dd className="min-w-0 text-sm sm:leading-6">{children}</dd>
    </div>
  );
}

function ActorValue({ event }: { event: AuditLog }) {
  const actor = describeAuditActor(event);
  const Icon = actor.icon;
  return (
    <div className="space-y-2">
      <div className="flex min-w-0 items-center gap-2.5">
        {actor.kind === "person" ? (
          <PersonAvatar name={actor.name} size={28} ring={false} />
        ) : actor.quiet ? (
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <Icon className="size-3.5" aria-hidden="true" />
          </span>
        ) : (
          <AgentIdenticon seed={actor.seed} name={actor.name} variant="agent" />
        )}
        <div className="min-w-0 leading-5">
          <div
            className={cn(
              "truncate font-medium",
              actor.quiet && "font-normal text-muted-foreground",
            )}
          >
            {actor.name}
          </div>
          <div className="truncate text-xs leading-4 text-muted-foreground">
            {actor.secondary}
          </div>
        </div>
      </div>
      {event.impersonatedBy && (
        <div className="flex items-start gap-1.5 text-xs leading-4 text-amber-700 dark:text-amber-400">
          <VenetianMask className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>
            Impersonated by{" "}
            <span className="font-medium">
              {event.impersonatedByEmail ?? "a since-deleted user"}
            </span>
          </span>
        </div>
      )}
      {event.actorId && <IdLine value={event.actorId} />}
    </div>
  );
}

function ResourceValue({ event }: { event: AuditLog }) {
  const name = resourceDisplayName(event);
  const Icon = auditResourceIcon(event.resourceType);
  if (!event.resourceType && !event.resourceId && !name) {
    return <span className="text-muted-foreground">None</span>;
  }
  return (
    <div className="space-y-1">
      <div className="flex min-w-0 items-center gap-1.5">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        {name && <span className="truncate font-medium">{name}</span>}
        {event.resourceType && (
          <span className="shrink-0 text-muted-foreground">
            {name ? <span>· </span> : null}
            {formatResourceType(event.resourceType)}
          </span>
        )}
      </div>
      {event.resourceId && <IdLine value={event.resourceId} />}
    </div>
  );
}

function RequestValue({ event }: { event: AuditLog }) {
  const { httpMethod, httpPath, httpRoute, httpStatus, requestId } = event;
  if (!httpMethod && !httpPath && !requestId) {
    return (
      <span className="text-muted-foreground">Background, no HTTP request</span>
    );
  }
  // MCP-tool rows carry a surface marker (`mcp-tool:<name>`) in httpPath with
  // no method.
  const mcpTool =
    !httpMethod && httpPath?.startsWith("mcp-tool:")
      ? httpPath.slice("mcp-tool:".length)
      : null;
  const failed = (httpStatus ?? 0) >= 400;

  return (
    <div className="space-y-1">
      {mcpTool ? (
        <div>
          <span className="text-muted-foreground">MCP tool </span>
          <code className="font-mono text-xs">{mcpTool}</code>
        </div>
      ) : httpPath ? (
        <div className="flex min-w-0 items-baseline gap-2">
          {httpMethod && (
            <span className="shrink-0 font-mono text-xs font-medium">
              {httpMethod}
            </span>
          )}
          <code className="min-w-0 font-mono text-xs break-all">
            {httpPath}
          </code>
          {httpStatus !== null && (
            <span
              className={cn(
                "ml-auto shrink-0 font-mono text-xs tabular-nums",
                failed ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {httpStatus}
            </span>
          )}
        </div>
      ) : null}
      {httpRoute && httpRoute !== httpPath && (
        <SubLine label="Route">
          <code className="font-mono break-all">{httpRoute}</code>
        </SubLine>
      )}
      {requestId && (
        <SubLine label="Request ID">
          <IdLine value={requestId} inline />
        </SubLine>
      )}
    </div>
  );
}

function ClientValue({ event }: { event: AuditLog }) {
  const { sourceIp, userAgent } = event;
  const parsed = useMemo(() => describeUserAgent(userAgent), [userAgent]);
  if (!sourceIp && !userAgent) {
    return <span className="text-muted-foreground">Not recorded</span>;
  }
  const DeviceIcon = parsed?.mobile ? Smartphone : Laptop;
  return (
    <div className="space-y-1">
      {parsed && (
        <div className="flex items-center gap-1.5">
          <DeviceIcon
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <span>{parsed.label}</span>
        </div>
      )}
      {sourceIp && (
        <SubLine label="IP address">
          <IdLine value={sourceIp} inline />
        </SubLine>
      )}
      {userAgent && (
        <p
          className="line-clamp-2 text-xs leading-4 break-all text-muted-foreground"
          title={userAgent}
        >
          {userAgent}
        </p>
      )}
    </div>
  );
}

function SubLine({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-xs leading-6">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}

/** A monospace identifier with its copy button. */
function IdLine({ value, inline }: { value: string; inline?: boolean }) {
  return (
    <span
      className={cn(
        "flex min-w-0 items-center gap-0.5",
        inline ? "inline-flex" : "-my-1",
      )}
    >
      <code className="min-w-0 truncate font-mono text-xs text-muted-foreground">
        {value}
      </code>
      <CopyButton text={value} size={12} />
    </span>
  );
}

function ChangesSummary({
  before,
  after,
  count,
}: {
  before: Snapshot;
  after: Snapshot;
  count: number;
}) {
  const hint = summarizeAuditDiffHints(before, after);
  if (before === null && after === null) return null;
  const kind =
    before === null ? "Created" : after === null ? "Deleted" : "Updated";
  return (
    <div className="space-y-0.5">
      <p className="text-sm font-medium">
        {kind}
        {count > 0 && (
          <span className="font-normal text-muted-foreground">
            {" "}
            · {count} {count === 1 ? "field" : "fields"}
          </span>
        )}
      </p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function NavButton({
  label,
  keys,
  target,
  onOpenEvent,
  children,
}: {
  label: string;
  keys: string[];
  target: AuditLog | undefined;
  onOpenEvent: (event: AuditLog) => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* aria-disabled keeps the tooltip reachable at either end. */}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          aria-disabled={!target}
          onClick={() => {
            if (target) onOpenEvent(target);
          }}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <span className="flex items-center gap-1.5">
          {target ? label : `No ${label.toLowerCase()} on this page`}
          {target && keys.map((key) => <Kbd key={key}>{key}</Kbd>)}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

function CopyLinkButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={copied ? "Link copied" : "Copy link"}
          onClick={async () => {
            try {
              await copyToClipboard(url);
              setCopied(true);
            } catch {
              toast.error("Couldn't copy the link");
            }
          }}
        >
          {copied ? (
            <Check className="text-emerald-600 dark:text-emerald-400" />
          ) : (
            <Link2 />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied" : "Copy link"}</TooltipContent>
    </Tooltip>
  );
}

function defaultTab(event: AuditLog): DrawerTab {
  return event.before != null || event.after != null ? "changes" : "overview";
}

/** Top-level fields that differ, ignoring timestamps — every field on a create or delete. */
function countChangedFields(before: Snapshot, after: Snapshot): number {
  if (before === null && after === null) return 0;
  if (before === null || after === null) {
    const snapshot = (before ?? after) as Record<string, unknown>;
    return Object.keys(snapshot).filter((k) => !METADATA_KEYS.has(k)).length;
  }
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  let count = 0;
  for (const key of keys) {
    if (METADATA_KEYS.has(key)) continue;
    if (stableStringify(before[key]) !== stableStringify(after[key])) count++;
  }
  return count;
}

function stableStringify(value: unknown): string {
  return (
    JSON.stringify(value, (_key, v: unknown) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
              a < b ? -1 : a > b ? 1 : 0,
            ),
          )
        : v,
    ) ?? "undefined"
  );
}

function describeUserAgent(
  userAgent: string | null | undefined,
): { label: string; mobile: boolean } | null {
  if (!userAgent) return null;
  const parsed = UAParser(userAgent);
  const browser = [parsed.browser.name, parsed.browser.major]
    .filter(Boolean)
    .join(" ");
  const label = [browser, parsed.os.name].filter(Boolean).join(" on ");
  if (!label) return null;
  return { label, mobile: parsed.device.type === "mobile" };
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

"use client";

import type { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { SearchInput } from "@/components/search-input";
import { TableFilters } from "@/components/table-filters";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { DateTimeRangePicker } from "@/components/ui/date-time-range-picker";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import {
  type AuditEventListItem,
  useAuditEvents,
} from "@/lib/audit-event.query";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import { useDateTimeRangePicker } from "@/lib/hooks/use-date-time-range-picker";
import { formatDate } from "@/lib/utils";

const EMPTY_ROWS: AuditEventListItem[] = [];

function settingsUserHref(userId: string): string {
  return `/settings/users?${new URLSearchParams({ tab: "users", userId }).toString()}`;
}

function getAuditActorUserId(event: AuditEventListItem): string | null {
  const actor = (
    event as AuditEventListItem & {
      actor?: {
        id: string;
        name: string;
        email: string;
        image?: string | null;
      } | null;
    }
  ).actor;
  return event.actorUserId ?? actor?.id ?? null;
}

export default function AuditLogPageClient() {
  const { searchParams, pageIndex, pageSize, offset, updateQueryParams } =
    useDataTableQueryParams({
      defaultPageSize: DEFAULT_TABLE_LIMIT,
    });

  const [tailEnabled, setTailEnabled] = useState(true);
  const [paused, setPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [newEventsCount, setNewEventsCount] = useState(0);
  const newestEventIdRef = useRef<string | null>(null);

  const actorUserIdFromUrl = searchParams.get("actorUserId");
  const actionFromUrl = searchParams.get("action");
  const resourceTypeFromUrl = searchParams.get("resourceType");
  const startDateFromUrl = searchParams.get("startDate");
  const endDateFromUrl = searchParams.get("endDate");
  const searchFromUrl = searchParams.get("search");

  const isFirstPage = pageIndex === 0;

  const dateTimePicker = useDateTimeRangePicker({
    startDateFromUrl,
    endDateFromUrl,
    onDateRangeChange: ({ startDate, endDate }) => {
      updateQueryParams({ startDate, endDate, page: "1" });
    },
  });

  const query = useMemo(
    () => ({
      limit: pageSize,
      offset,
      actorUserId: actorUserIdFromUrl || undefined,
      action: actionFromUrl || undefined,
      resourceType: resourceTypeFromUrl || undefined,
      from: dateTimePicker.startDateParam,
      to: dateTimePicker.endDateParam,
      search: searchFromUrl || undefined,
    }),
    [
      actionFromUrl,
      actorUserIdFromUrl,
      dateTimePicker.endDateParam,
      dateTimePicker.startDateParam,
      offset,
      pageSize,
      resourceTypeFromUrl,
      searchFromUrl,
    ],
  );

  const { data: response, isFetching } = useAuditEvents(query);

  const [streamRows, setStreamRows] = useState<AuditEventListItem[]>([]);
  const baseRows = response?.data ?? EMPTY_ROWS;

  const rows = tailEnabled && isFirstPage ? streamRows : baseRows;
  const pagination = response?.pagination;
  const hasFilters =
    !!actorUserIdFromUrl ||
    !!actionFromUrl ||
    !!resourceTypeFromUrl ||
    dateTimePicker.startDate !== undefined ||
    !!searchFromUrl;

  const columns: ColumnDef<AuditEventListItem>[] = [
    {
      id: "createdAt",
      header: "Date",
      cell: ({ row }) => (
        <div className="font-mono text-xs">
          {formatDate({ date: row.original.createdAt })}
        </div>
      ),
    },
    {
      id: "actorUserId",
      header: "Actor",
      cell: ({ row }) => {
        const ev = row.original;
        if (!(ev.actorUserId || ev.actor)) {
          return <span className="text-xs text-muted-foreground">System</span>;
        }
        const userId = getAuditActorUserId(ev);
        const label = (
          <span className="line-clamp-2 max-w-[11rem] text-xs leading-snug">
            {getActorLabel(ev)}
          </span>
        );
        if (!userId) return label;
        return (
          <Link
            href={settingsUserHref(userId)}
            className="text-foreground underline-offset-4 hover:underline"
          >
            {label}
          </Link>
        );
      },
    },
    {
      id: "action",
      header: "Action",
      cell: ({ row }) => {
        const parts = auditRowParts(row.original);
        const inner = (
          <div className="flex min-w-0 max-w-[220px] flex-col gap-1">
            <Badge
              variant="secondary"
              className="h-auto w-fit max-w-full whitespace-normal py-1.5 text-left text-xs font-normal leading-tight"
            >
              {parts.headline}
            </Badge>
            {parts.subline ? (
              <span className="font-mono text-[10px] leading-tight text-muted-foreground">
                {parts.subline}
              </span>
            ) : null}
          </div>
        );

        if (parts.kind === "http" && parts.tooltip) {
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className="inline-block max-w-[220px] cursor-help text-left outline-none"
                  tabIndex={0}
                >
                  {inner}
                </span>
              </TooltipTrigger>
              <TooltipContent
                side="top"
                align="start"
                className="max-w-md border bg-popover px-3 py-2 font-mono text-[11px] leading-relaxed"
              >
                {parts.tooltip}
              </TooltipContent>
            </Tooltip>
          );
        }

        return inner;
      },
    },
    {
      id: "resourceId",
      header: "Resource IDs",
      cell: ({ row }) => <ResourceIdsCell event={row.original} />,
    },
    {
      id: "ipAddress",
      header: "IP",
      cell: ({ row }) =>
        row.original.ipAddress ? (
          <code className="text-xs">{row.original.ipAddress}</code>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
    {
      id: "details",
      header: "",
      cell: ({ row }) => <AuditEventDetailsDialog event={row.original} />,
    },
  ];

  // Keep the stream list in sync with the latest first-page fetch.
  useEffect(() => {
    if (!tailEnabled || !isFirstPage) return;
    setStreamRows(baseRows);
    newestEventIdRef.current = baseRows[0]?.id ?? null;
    setNewEventsCount(0);
  }, [baseRows, isFirstPage, tailEnabled]);

  // SSE tail: only enabled for first page and when there are no filters
  const sseEnabled = tailEnabled && isFirstPage && !hasFilters && !paused;
  useEffect(() => {
    if (!sseEnabled) return;

    const after = new Date().toISOString();
    const source = new EventSource(
      `/api/audit-events/stream?after=${encodeURIComponent(after)}`,
    );

    const onAuditEvent = (messageEvent: MessageEvent<string>) => {
      const incoming = safeParseAuditEvent(messageEvent.data);
      if (!incoming) return;

      setStreamRows((current) =>
        mergeNewAuditEvent({
          current,
          incoming,
          max: pageSize,
        }),
      );

      // Track "new events" when auto-scroll is off
      if (!autoScroll) {
        setNewEventsCount((c) => c + 1);
      } else {
        newestEventIdRef.current = incoming.id;
        setNewEventsCount(0);
      }
    };

    source.addEventListener("auditEvent", onAuditEvent as EventListener);
    source.addEventListener("error", () => {
      // Browser will auto-retry. No-op.
    });

    return () => {
      source.close();
    };
  }, [autoScroll, pageSize, sseEnabled]);

  useEffect(() => {
    if (!autoScroll || paused || !tailEnabled) return;
    // In this table, newest entries are at the top, so “auto-scroll” means “keep at top”.
    window.scrollTo({ top: 0 });
  }, [autoScroll, paused, tailEnabled]);

  return (
    <div className="space-y-4">
      <TableFilters>
        <SearchInput
          objectNamePlural="events"
          searchFields={["action", "resource", "resource id", "ip"]}
          paramName="search"
        />
        <DateTimeRangePicker
          startDate={dateTimePicker.startDate}
          endDate={dateTimePicker.endDate}
          isDialogOpen={dateTimePicker.isDateDialogOpen}
          tempStartDate={dateTimePicker.tempStartDate}
          tempEndDate={dateTimePicker.tempEndDate}
          displayText={dateTimePicker.getDateRangeDisplay()}
          onDialogOpenChange={dateTimePicker.setIsDateDialogOpen}
          onTempStartDateChange={dateTimePicker.setTempStartDate}
          onTempEndDateChange={dateTimePicker.setTempEndDate}
          onOpenDialog={dateTimePicker.openDateDialog}
          onApply={dateTimePicker.handleApplyDateRange}
        />

        <div className="ml-auto flex items-center gap-3">
          <div className="flex items-center gap-2 text-sm">
            <Switch
              checked={tailEnabled}
              onCheckedChange={(checked) => setTailEnabled(checked)}
            />
            <span className="text-muted-foreground">Tail</span>
          </div>

          <div className="flex items-center gap-2 text-sm">
            <Switch
              checked={!paused}
              disabled={!tailEnabled}
              onCheckedChange={(checked) => setPaused(!checked)}
            />
            <span className="text-muted-foreground">Live</span>
          </div>

          <div className="flex items-center gap-2 text-sm">
            <Switch
              checked={autoScroll}
              disabled={!tailEnabled || paused}
              onCheckedChange={(checked) => setAutoScroll(checked)}
            />
            <span className="text-muted-foreground">Auto-scroll</span>
          </div>

          {newEventsCount > 0 && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setNewEventsCount(0);
                window.scrollTo({ top: 0, behavior: "smooth" });
              }}
            >
              {newEventsCount} new
            </Button>
          )}
        </div>
      </TableFilters>

      <DataTable
        columns={columns}
        data={rows}
        hideSelectedCount
        manualPagination
        pagination={{
          pageIndex,
          pageSize,
          total: pagination?.total ?? 0,
        }}
        onPaginationChange={(newPagination) => {
          updateQueryParams({
            page: String(newPagination.pageIndex + 1),
            pageSize: String(newPagination.pageSize),
          });
        }}
        isLoading={isFetching}
        hasActiveFilters={hasFilters}
        emptyMessage="No audit events yet."
        filteredEmptyMessage="No audit events match your filters."
        onClearFilters={() => {
          dateTimePicker.clearDateRange();
          updateQueryParams({
            actorUserId: null,
            action: null,
            resourceType: null,
            startDate: null,
            endDate: null,
            search: null,
            page: "1",
          });
        }}
      />
    </div>
  );
}

function AuditEventDetailsDialog(params: { event: AuditEventListItem }) {
  const { event } = params;
  const metadata = event.metadata ?? null;
  const actorEmail = getActorEmailForDetails(event);
  const actorUserLinkId = getAuditActorUserId(event);

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          Details
        </Button>
      </DialogTrigger>
      <DialogContent className="gap-0 sm:max-w-xl">
        <DialogHeader className="space-y-1 pb-2 text-left">
          <DialogTitle className="text-lg">Audit event</DialogTitle>
          <p className="text-sm font-medium leading-snug text-foreground">
            {getFriendlyActionLabel(event)}
          </p>
          <p className="font-mono text-[11px] text-muted-foreground">
            {event.action}
          </p>
        </DialogHeader>

        <div className="space-y-4 pb-4 text-sm">
          <div>
            <div className="text-xs text-muted-foreground">Resource</div>
            <div className="mt-1 min-w-0 break-words text-foreground">
              {getFriendlyResourceLabel(event)}
              {event.resourceId ? (
                <span className="mt-0.5 block break-all font-mono text-xs text-muted-foreground">
                  {event.resourceId}
                </span>
              ) : null}
            </div>
          </div>

          <div>
            <div className="text-xs text-muted-foreground">Actor</div>
            <div className="mt-1 space-y-1">
              <p className="text-sm font-medium leading-snug text-foreground">
                {event.actorUserId || event.actor ? (
                  actorUserLinkId ? (
                    <Link
                      href={settingsUserHref(actorUserLinkId)}
                      className="underline-offset-4 hover:underline"
                    >
                      {getActorLabel(event)}
                    </Link>
                  ) : (
                    getActorLabel(event)
                  )
                ) : (
                  "System"
                )}
              </p>
              {(event.actorUserId || event.actor) && actorEmail ? (
                <p className="break-all font-mono text-[11px] text-muted-foreground">
                  {actorEmail}
                </p>
              ) : null}
            </div>
          </div>

          <div>
            <div className="text-xs text-muted-foreground">IP</div>
            <div className="mt-1 font-mono text-xs">{event.ipAddress ?? "—"}</div>
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground">Details</div>
          <div className="max-h-[min(50vh,24rem)] overflow-auto rounded-lg bg-muted/50 p-4 text-sm leading-relaxed">
            {renderAuditEventDetails(event, metadata)}
          </div>
        </div>

        <div className="flex justify-end pt-2">
          <DialogClose asChild>
            <Button variant="secondary">Close</Button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function getActorLabel(event: AuditEventListItem): string {
  const actor = (event as AuditEventListItem & {
    actor?: { id: string; name: string; email: string; image?: string | null } | null;
  }).actor;

  // Short labels for the table (no email). Details dialog uses getActorEmailForDetails for a second line.
  if (actor?.name) return actor.name;
  if (actor?.id) return shortenId(actor.id);

  const id = event.actorUserId;
  if (!id) return "System";
  return shortenId(id);
}

function getActorEmailForDetails(event: AuditEventListItem): string | null {
  const actor = (event as AuditEventListItem & {
    actor?: { id: string; name: string; email: string; image?: string | null } | null;
  }).actor;
  const raw = actor?.email;
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  return null;
}

function getResourceLabel(event: AuditEventListItem): string | null {
  const metadata = event.metadata as Record<string, unknown> | null | undefined;
  if (!metadata) return null;

  if (
    event.resourceType === "http" &&
    typeof metadata.url === "string" &&
    typeof metadata.method === "string"
  ) {
    const hint = httpMutationPresentation(metadata).objectHint;
    if (hint) return hint;
  }

  // Common "name" pattern
  if (typeof metadata.name === "string" && metadata.name.trim().length > 0) {
    return metadata.name;
  }

  // Update events often store before/after
  const after = metadata.after as Record<string, unknown> | undefined;
  const before = metadata.before as Record<string, unknown> | undefined;
  const afterName = after && typeof after.name === "string" ? after.name : null;
  const beforeName =
    before && typeof before.name === "string" ? before.name : null;
  return afterName || beforeName || null;
}

function shortenId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

/** Standard UUID or 32-char hex (no dashes). */
function isUuidLike(segment: string): boolean {
  const s = segment.trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    s,
  )
    ? true
    : /^[0-9a-f]{32}$/i.test(s);
}

function shortenUuidSegment(segment: string): string {
  const s = segment.trim();
  if (/^[0-9a-f]{32}$/i.test(s)) {
    return `${s.slice(0, 8)}…${s.slice(-4)}`;
  }
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
  ) {
    return s.length > 14 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s;
  }
  return segment;
}

/** Shorten any UUID tokens embedded in free-form text (safety net). */
function shortenUuidsInText(text: string): string {
  return text.replace(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    (m) => shortenUuidSegment(m),
  );
}

const HYPHEN_SEGMENT_ACRONYMS: Record<string, string> = {
  llm: "LLM",
  mcp: "MCP",
  api: "API",
  oidc: "OIDC",
  sso: "SSO",
};

function titleCaseHyphenSegment(segment: string): string {
  return segment
    .split("-")
    .map((word) => {
      const lower = word.toLowerCase();
      if (HYPHEN_SEGMENT_ACRONYMS[lower]) {
        return HYPHEN_SEGMENT_ACRONYMS[lower];
      }
      if (word.length === 0) return word;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}

function formatPathSegment(segment: string): string {
  if (isUuidLike(segment)) return shortenUuidSegment(segment);
  return titleCaseHyphenSegment(segment);
}

/** Human-readable path after /api/ (e.g. llm-models/sync → "LLM models · Sync"). UUID segments shorten to abcde…wxyz. */
function apiPathToFriendlyLabel(pathOrUrl: string): string {
  const path =
    pathOrUrl.split("?")[0]?.replace(/^\/api\/?/, "").replace(/\/$/, "") ?? "";
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return "API";
  return segments.map(formatPathSegment).join(" · ");
}

function parseApiPath(url: string): string[] {
  const pathOnly = url.split("?")[0] ?? "";
  return pathOnly.replace(/^\/api\/?/, "").split("/").filter(Boolean);
}

type LinkedAuditResourceId = { id: string; href: string | null };

function domainResourceHref(resourceType: string, resourceId: string): string | null {
  switch (resourceType) {
    case "scheduleTrigger":
      return `/scheduled-tasks/${encodeURIComponent(resourceId)}`;
    case "agent":
      return `/agents?${new URLSearchParams({ view: resourceId }).toString()}`;
    default:
      return null;
  }
}

/** UUID segments in /api paths → deep links where the UI supports it. */
function linkedResourceIdsFromApiUrl(url: string): LinkedAuditResourceId[] {
  const segments = parseApiPath(url);
  const out: LinkedAuditResourceId[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (!isUuidLike(seg)) continue;

    let href: string | null = null;

    if (i >= 1 && segments[i - 1] === "agents") {
      href = `/agents?${new URLSearchParams({ view: seg }).toString()}`;
    } else if (i >= 1 && segments[i - 1] === "schedule-triggers") {
      href = `/scheduled-tasks/${encodeURIComponent(seg)}`;
    } else if (
      i >= 3 &&
      segments[i - 1] === "runs" &&
      segments[i - 3] === "schedule-triggers"
    ) {
      const triggerId = segments[i - 2]!;
      if (isUuidLike(triggerId)) {
        href = `/scheduled-tasks/${encodeURIComponent(triggerId)}/runs/${encodeURIComponent(seg)}`;
      }
    } else if (
      i >= 3 &&
      segments[i - 1] === "tools" &&
      segments[i - 3] === "agents"
    ) {
      const agentId = segments[i - 2]!;
      if (isUuidLike(agentId)) {
        href = `/agents?${new URLSearchParams({ view: agentId }).toString()}`;
      }
    }

    out.push({ id: seg, href });
  }
  return out;
}

function inferResourceCategoryFromSegments(segments: string[]): string {
  const structural = segments.filter((s) => !isUuidLike(s));
  if (structural.length === 0) return "API";
  return structural.map(titleCaseHyphenSegment).join(" · ");
}

/** Table + dialog copy for generic HTTP audit rows (`http.mutation` and similar). */
function httpMutationPresentation(
  meta: Record<string, unknown>,
  options?: { fullIds?: boolean },
): {
  headline: string;
  subline: string | undefined;
  resourceCategory: string;
  objectHint: string | null;
  tooltipLines: string[];
} {
  const fullIds = options?.fullIds === true;
  const presSeg = (segment: string) => {
    if (isUuidLike(segment)) {
      return fullIds ? segment : shortenUuidSegment(segment);
    }
    return titleCaseHyphenSegment(segment);
  };

  const method = (typeof meta.method === "string" ? meta.method : "GET").toUpperCase();
  const url = typeof meta.url === "string" ? meta.url : "";
  const statusCode =
    typeof meta.statusCode === "number" ? meta.statusCode : null;

  const segments = parseApiPath(url);
  const fullTooltip = `${method} ${url}${statusCode != null ? ` → ${statusCode}` : ""}`;
  const tooltipLines = [fullIds ? fullTooltip : shortenUuidsInText(fullTooltip)];

  const agIdx = segments.indexOf("agents");
  if (agIdx !== -1 && segments[agIdx + 2] === "tools" && segments.length > agIdx + 3) {
    const agentId = segments[agIdx + 1]!;
    const toolId = segments[agIdx + 3]!;
    const ag = presSeg(agentId);
    const tl = presSeg(toolId);
    const fingerprint = `${ag} · ${tl}`;
    let headline = "Agent tool change";
    if (method === "POST") headline = "Tool linked to agent";
    else if (method === "DELETE") headline = "Tool removed from agent";
    else if (method === "PUT" || method === "PATCH") headline = "Tool link updated";
    return {
      headline,
      subline: fingerprint,
      resourceCategory: "Agent · Tools",
      objectHint: fingerprint,
      tooltipLines,
    };
  }

  if (agIdx !== -1 && segments[agIdx + 1]) {
    const rest = segments.slice(agIdx + 2);
    if (rest.length === 0 && !segments[agIdx + 2]) {
      const agentId = segments[agIdx + 1]!;
      const aid = presSeg(agentId);
      let headline = "Agent change";
      if (method === "DELETE") headline = "Deleted agent";
      else if (method === "POST") headline = "Created agent";
      else if (method === "PUT" || method === "PATCH") headline = "Updated agent";
      return {
        headline,
        subline: aid,
        resourceCategory: "Agent",
        objectHint: aid,
        tooltipLines,
      };
    }
  }

  if (segments[0] === "agents" && segments.length === 1 && method === "POST") {
    return {
      headline: "Created agent",
      subline: undefined,
      resourceCategory: "Agent",
      objectHint: null,
      tooltipLines,
    };
  }

  const tmIdx = segments.indexOf("teams");
  if (tmIdx !== -1 && segments[tmIdx + 1] && segments.length === tmIdx + 2) {
    const teamId = segments[tmIdx + 1]!;
    const tid = presSeg(teamId);
    let headline = "Team change";
    if (method === "DELETE") headline = "Deleted team";
    else if (method === "POST") headline = "Created team";
    else if (method === "PUT" || method === "PATCH") headline = "Updated team";
    return {
      headline,
      subline: tid,
      resourceCategory: "Team",
      objectHint: tid,
      tooltipLines,
    };
  }

  if (segments[0] === "teams" && segments.length === 1 && method === "POST") {
    return {
      headline: "Created team",
      subline: undefined,
      resourceCategory: "Team",
      objectHint: null,
      tooltipLines,
    };
  }

  const msIdx = segments.indexOf("mcp_server");
  if (msIdx !== -1) {
    const sidRaw = segments[msIdx + 1];
    const sub = segments[msIdx + 2];
    const sid = sidRaw ? presSeg(sidRaw) : "";

    if (sub === "reinstall") {
      return {
        headline: "MCP server reinstalled",
        subline: sid || undefined,
        resourceCategory: "MCP server",
        objectHint: sid || null,
        tooltipLines,
      };
    }
    if (sub === "reauthenticate") {
      return {
        headline: "MCP server reauthenticated",
        subline: sid || undefined,
        resourceCategory: "MCP server",
        objectHint: sid || null,
        tooltipLines,
      };
    }
    if (sub === "tools" || sub === "inspect" || sub === "installation-status") {
      const cat =
        sub === "tools"
          ? "MCP server · Tools"
          : sub === "inspect"
            ? "MCP server · Inspect"
            : "MCP server · Install status";
      return {
        headline: `${method} · MCP server`,
        subline: sid || undefined,
        resourceCategory: cat,
        objectHint: sid || null,
        tooltipLines,
      };
    }
    if (sidRaw) {
      let headline = "MCP server change";
      if (method === "DELETE") headline = "Deleted MCP server";
      else if (method === "PUT" || method === "PATCH") headline = "Updated MCP server";
      else if (method === "POST") headline = "MCP server request";
      return {
        headline,
        subline: sid || undefined,
        resourceCategory: "MCP server",
        objectHint: sid || null,
        tooltipLines,
      };
    }
  }

  if (segments[0] === "mcp_server" && segments.length === 1 && method === "POST") {
    return {
      headline: "Created MCP server",
      subline: undefined,
      resourceCategory: "MCP server",
      objectHint: null,
      tooltipLines,
    };
  }

  const stIdx = segments.indexOf("schedule-triggers");
  if (stIdx !== -1) {
    const triggerIdSeg = segments[stIdx + 1];
    const subPath = segments[stIdx + 2];
    const resourceCategory = "Scheduled trigger";
    const tid = triggerIdSeg ? presSeg(triggerIdSeg) : null;

    if (!triggerIdSeg) {
      let headline = "Schedule trigger change";
      if (method === "POST") headline = "Created schedule trigger";
      return {
        headline,
        subline: undefined,
        resourceCategory,
        objectHint: null,
        tooltipLines,
      };
    }

    let headline = "Updated schedule trigger";
    if (method === "DELETE") headline = "Deleted schedule trigger";
    else if (method === "PUT" || method === "PATCH") headline = "Updated schedule trigger";
    else if (subPath === "enable") headline = "Enabled schedule trigger";
    else if (subPath === "disable") headline = "Disabled schedule trigger";
    else if (subPath === "run-now") headline = "Manual schedule run started";
    else if (subPath === "runs") {
      const runSeg = segments[stIdx + 3];
      if (runSeg && isUuidLike(runSeg)) {
        return {
          headline: "Schedule run opened",
          subline: `${tid} · ${presSeg(runSeg)}`,
          resourceCategory: "Scheduled trigger · Run",
          objectHint: `${tid} · ${presSeg(runSeg)}`,
          tooltipLines,
        };
      }
    }

    return {
      headline,
      subline: tid ?? undefined,
      resourceCategory,
      objectHint: tid,
      tooltipLines,
    };
  }

  const last = segments[segments.length - 1] ?? "";
  const parents = segments.slice(0, -1);
  if (last === "sync" && parents.length > 0) {
    const target = parents.map(presSeg).join(" ");
    const category = inferResourceCategoryFromSegments(parents);
    return {
      headline: `Synced ${target}`,
      subline: undefined,
      resourceCategory: category,
      objectHint: null,
      tooltipLines,
    };
  }

  const category = inferResourceCategoryFromSegments(segments);
  const uuidHints = segments
    .filter((s) => isUuidLike(s))
    .map((s) => (fullIds ? s : shortenUuidSegment(s)));
  const objectHint = uuidHints.length > 0 ? uuidHints.join(" · ") : null;

  let headline =
    category !== "API"
      ? `${method} · ${category}`
      : method
        ? `${method} request`
        : "API request";
  if (method === "DELETE" && category !== "API") headline = `Deleted · ${category}`;
  else if ((method === "PUT" || method === "PATCH") && category !== "API")
    headline = `Updated · ${category}`;
  else if (method === "POST" && category !== "API") headline = `Created · ${category}`;

  return {
    headline,
    subline: objectHint ?? undefined,
    resourceCategory: category === "API" && segments.length > 0 ? "HTTP API" : category,
    objectHint,
    tooltipLines,
  };
}

type AuditRowParts =
  | {
      kind: "http";
      headline: string;
      subline: string | undefined;
      tooltip: string;
      resource: string;
      objectHint: string | null;
    }
  | {
      kind: "domain";
      headline: string;
      subline: string | undefined;
      tooltip: "";
      resource: string;
      objectHint: string | null;
    };

function auditRowParts(event: AuditEventListItem): AuditRowParts {
  const meta = event.metadata as Record<string, unknown> | undefined;
  const looksLikeHttpAudit =
    event.action === "http.mutation" ||
    (event.resourceType === "http" &&
      meta &&
      typeof meta.method === "string" &&
      typeof meta.url === "string");

  if (looksLikeHttpAudit && meta) {
    const p = httpMutationPresentation(meta);
    return {
      kind: "http",
      headline: shortenUuidsInText(p.headline),
      subline: p.subline,
      tooltip: p.tooltipLines.join("\n"),
      resource: p.resourceCategory,
      objectHint: p.objectHint,
    };
  }

  const objectHint = (() => {
    if (event.resourceType === "scheduleTrigger" && event.resourceId) {
      return shortenId(event.resourceId);
    }
    return (
      getResourceLabel(event) ??
      (event.resourceId ? shortenId(event.resourceId) : null)
    );
  })();

  return {
    kind: "domain",
    headline: getFriendlyActionLabel(event),
    subline: undefined,
    tooltip: "",
    resource: getFriendlyResourceLabel(event),
    objectHint,
  };
}

function ResourceIdsCell({ event }: { event: AuditEventListItem }) {
  const meta = event.metadata as Record<string, unknown> | undefined;

  if (
    event.resourceType === "http" &&
    meta &&
    typeof meta.url === "string" &&
    typeof meta.method === "string"
  ) {
    const linked = linkedResourceIdsFromApiUrl(meta.url);
    if (linked.length > 0) {
      return (
        <div className="max-w-[14rem] font-mono text-[11px] leading-snug">
          {linked.map((item, i) => (
            <span key={`${item.id}-${i}`}>
              {i > 0 ? (
                <span className="text-muted-foreground"> · </span>
              ) : null}
              {item.href ? (
                <Link
                  href={item.href}
                  className="text-foreground underline-offset-4 hover:underline"
                >
                  {shortenId(item.id)}
                </Link>
              ) : (
                <span className="text-muted-foreground">{shortenId(item.id)}</span>
              )}
            </span>
          ))}
        </div>
      );
    }
  }

  if (event.resourceType !== "http" && event.resourceId) {
    const href = domainResourceHref(event.resourceType, event.resourceId);
    const display = shortenId(event.resourceId);
    if (href) {
      return (
        <Link
          href={href}
          className="block max-w-[11rem] font-mono text-[11px] text-foreground underline-offset-4 hover:underline"
        >
          {display}
        </Link>
      );
    }
    return (
      <span className="block max-w-[11rem] font-mono text-[11px] text-muted-foreground">
        {display}
      </span>
    );
  }

  const parts = auditRowParts(event);
  if (parts.objectHint) {
    return (
      <span className="block max-w-[11rem] font-mono text-[11px] leading-snug text-muted-foreground">
        {parts.objectHint}
      </span>
    );
  }

  const fallback = getResourceLabel(event);
  if (fallback) {
    return (
      <span className="line-clamp-2 max-w-[11rem] text-xs text-muted-foreground">
        {fallback}
      </span>
    );
  }

  return <span className="text-xs text-muted-foreground">—</span>;
}

function getFriendlyActionLabel(event: AuditEventListItem): string {
  const raw = event.action;
  const meta = event.metadata as Record<string, unknown> | null | undefined;

  let label: string;
  if (raw === "http.mutation" && meta) {
    label = httpMutationPresentation(meta).headline;
  } else {
    const domainMatch =
      /^([a-zA-Z]+)\.(create|update|delete|install|uninstall|reinstall|enable|disable|runNow)$/.exec(
        raw,
      );
    if (domainMatch) {
      const [, resource, verb] = domainMatch;
      if (resource === "scheduleTrigger" && verb === "runNow") {
        label = "Started manual schedule run";
      } else {
        const verbs: Record<string, string> = {
          create: "Created",
          update: "Updated",
          delete: "Deleted",
          install: "Installed",
          uninstall: "Uninstalled",
          reinstall: "Reinstalled",
          enable: "Enabled",
          disable: "Disabled",
        };
        const nouns: Record<string, string> = {
          team: "team",
          agent: "agent",
          mcpServer: "MCP server",
          scheduleTrigger: "schedule trigger",
        };
        const v = verbs[verb] ?? verb;
        const n = nouns[resource] ?? resource;
        label = `${v} ${n}`;
      }
    } else {
      label = raw.replace(/\./g, " ");
    }
  }

  return shortenUuidsInText(label);
}

function getFriendlyResourceLabel(event: AuditEventListItem): string {
  if (event.resourceType === "http") {
    const meta = event.metadata as Record<string, unknown> | undefined;
    if (meta && typeof meta.url === "string" && typeof meta.method === "string") {
      return httpMutationPresentation(meta).resourceCategory;
    }
    if (meta && typeof meta.url === "string") {
      const label = apiPathToFriendlyLabel(meta.url);
      const out = label === "API" ? "HTTP API" : label;
      return shortenUuidsInText(out);
    }
    return "HTTP API";
  }

  const labels: Record<string, string> = {
    team: "Team",
    agent: "Agent",
    mcpServer: "MCP server",
    scheduleTrigger: "Scheduled trigger",
    http: "HTTP API",
  };
  return labels[event.resourceType] ?? event.resourceType;
}

function renderAuditEventDetails(
  event: AuditEventListItem,
  metadata: Record<string, unknown> | null,
) {
  const action = event.action;

  if (action === "http.mutation" && metadata) {
    const method = typeof metadata.method === "string" ? metadata.method : "HTTP";
    const url = typeof metadata.url === "string" ? metadata.url : "";
    const statusCode =
      typeof metadata.statusCode === "number" ? metadata.statusCode : null;
    const p = httpMutationPresentation(metadata, { fullIds: true });
    return (
      <div className="space-y-3">
        <p className="text-base font-medium text-foreground">{p.headline}</p>
        {p.subline ? (
          <p className="break-all font-mono text-xs text-muted-foreground">
            {p.subline}
          </p>
        ) : null}
        <div className="rounded-md bg-muted/60 px-3 py-2 font-mono text-xs text-muted-foreground break-all">
          {`${method} ${url}${statusCode != null ? ` → ${statusCode}` : ""}`}
        </div>
      </div>
    );
  }

  if (action.startsWith("scheduleTrigger.") && metadata) {
    const name = typeof metadata.name === "string" ? metadata.name : null;
    const runId = typeof metadata.runId === "string" ? metadata.runId : null;
    return (
      <div className="space-y-2">
        {name ? <div>Trigger “{name}”</div> : null}
        {event.resourceId ? (
          <div className="break-all font-mono text-xs text-muted-foreground">
            Trigger id: {event.resourceId}
          </div>
        ) : null}
        {runId ? (
          <div className="break-all font-mono text-xs text-muted-foreground">
            Run id: {runId}
          </div>
        ) : null}
      </div>
    );
  }

  if (action === "team.create" && metadata && typeof metadata.name === "string") {
    return <div>Created team “{metadata.name}”.</div>;
  }

  if (action === "team.delete" && metadata && typeof metadata.name === "string") {
    return <div>Deleted team “{metadata.name}”.</div>;
  }

  if (action === "agent.create" && metadata && typeof metadata.name === "string") {
    const agentType =
      typeof metadata.agentType === "string" ? metadata.agentType : null;
    return (
      <div>
        Created agent “{metadata.name}”
        {agentType ? ` (${agentType})` : ""}.
      </div>
    );
  }

  if (action === "agent.delete" && metadata && typeof metadata.name === "string") {
    const agentType =
      typeof metadata.agentType === "string" ? metadata.agentType : null;
    return (
      <div>
        Deleted agent “{metadata.name}”
        {agentType ? ` (${agentType})` : ""}.
      </div>
    );
  }

  if (action === "team.update" && metadata) {
    const before = metadata.before as Record<string, unknown> | undefined;
    const after = metadata.after as Record<string, unknown> | undefined;
    if (before && after) {
      const changes: Array<{ field: string; from: unknown; to: unknown }> = [];
      for (const key of Object.keys({ ...before, ...after })) {
        if (before[key] !== after[key]) {
          changes.push({ field: key, from: before[key], to: after[key] });
        }
      }
      if (changes.length > 0) {
        return (
          <div className="space-y-2">
            <div>Updated team:</div>
            <ul className="list-inside list-disc space-y-1">
              {changes.map((c) => (
                <li key={c.field}>
                  <span className="font-medium">{c.field}</span>:{" "}
                  <span className="font-mono">{stringifyValue(c.from)}</span> →{" "}
                  <span className="font-mono">{stringifyValue(c.to)}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      }
    }
  }

  if (
    action === "agent.update" &&
    metadata &&
    typeof metadata.before === "object" &&
    typeof metadata.after === "object"
  ) {
    const before = metadata.before as Record<string, unknown>;
    const after = metadata.after as Record<string, unknown>;
    const changes: Array<{ field: string; from: unknown; to: unknown }> = [];
    for (const key of Object.keys({ ...before, ...after })) {
      if (before[key] !== after[key]) {
        changes.push({ field: key, from: before[key], to: after[key] });
      }
    }
    if (changes.length > 0) {
      return (
        <div className="space-y-2">
          <div>Updated agent:</div>
          <ul className="list-inside list-disc space-y-1">
            {changes.map((c) => (
              <li key={c.field}>
                <span className="font-medium">{c.field}</span>:{" "}
                <span className="font-mono">{stringifyValue(c.from)}</span> →{" "}
                <span className="font-mono">{stringifyValue(c.to)}</span>
              </li>
            ))}
          </ul>
        </div>
      );
    }
  }

  if (
    action === "mcpServer.install" &&
    metadata &&
    typeof metadata.name === "string"
  ) {
    return <div>Installed MCP server “{metadata.name}”.</div>;
  }

  if (
    action === "mcpServer.uninstall" &&
    metadata &&
    typeof metadata.name === "string"
  ) {
    return <div>Uninstalled MCP server “{metadata.name}”.</div>;
  }

  if (
    action === "mcpServer.reinstall" &&
    metadata &&
    typeof metadata.name === "string"
  ) {
    return <div>Reinstalled MCP server “{metadata.name}”.</div>;
  }

  // Generic structured diff fallback (emitted by audit middleware)
  if (metadata && Array.isArray(metadata.changes)) {
    const changes = metadata.changes as Array<{
      field?: unknown;
      from?: unknown;
      to?: unknown;
    }>;
    const safeChanges = changes.filter(
      (c) => typeof c?.field === "string" && (c.from !== c.to),
    ) as Array<{ field: string; from: unknown; to: unknown }>;

    if (safeChanges.length > 0) {
      const resourceName =
        typeof metadata.resourceName === "string" ? metadata.resourceName : null;

      return (
        <div className="space-y-2">
          <div>
            {resourceName ? (
              <>
                Changed <span className="font-medium">{resourceName}</span>:
              </>
            ) : (
              "Changed fields:"
            )}
          </div>
          <ul className="list-inside list-disc space-y-1">
            {safeChanges.map((c) => (
              <li key={c.field}>
                <span className="font-medium">{c.field}</span>:{" "}
                <span className="font-mono">{stringifyValue(c.from)}</span> →{" "}
                <span className="font-mono">{stringifyValue(c.to)}</span>
              </li>
            ))}
          </ul>
        </div>
      );
    }
  }

  return (
    <pre className="whitespace-pre-wrap">
      {metadata ? JSON.stringify(metadata, null, 2) : "—"}
    </pre>
  );
}

function stringifyValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function mergeNewAuditEvent(params: {
  current: AuditEventListItem[];
  incoming: AuditEventListItem;
  max: number;
}) {
  const { current, incoming, max } = params;
  if (current.some((e) => e.id === incoming.id)) return current;
  return [incoming, ...current].slice(0, max);
}

function safeParseAuditEvent(raw: string): AuditEventListItem | null {
  try {
    const parsed = JSON.parse(raw) as AuditEventListItem;
    if (!parsed || typeof parsed !== "object") return null;
    if (!("id" in parsed) || typeof parsed.id !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

"use client";

import { E2eTestId } from "@archestra/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { Button } from "@/components/ui/button";
import { useAutoModeAgents } from "@/lib/mcp/mcp-server.query";
import {
  describeMcpServerIssue,
  type McpServerIssue,
} from "@/lib/mcp/mcp-server-issues";
import { cn } from "@/lib/utils";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { deriveAgentUsage } from "./mcp-server-agent-usage";
import type { CatalogItem, InstalledServer } from "./mcp-server-card";
import { McpServerIssueBadge } from "./mcp-server-issue-badge";
import { humanizeOAuthErrorCode } from "./oauth-reauth-detail";

/**
 * One server's outstanding issue, explained. Two densities:
 *
 * - `panel` (the server's Overview): status pill, what the status means and
 *   the concrete next step, who is affected, the raw runtime message behind a
 *   disclosure, and both verbs. The page has no other context, so the panel
 *   carries the whole diagnosis.
 * - `row` (the registry's Needs-attention list): the section header already
 *   says what kind of trouble this is and the button says what to do about
 *   it, so the row is just name, one line of cause, one muted line of facts
 *   (with a short raw message inline) and the single verb that clears it.
 *
 * `onReinstall` is the registry page's confirm-dialog flow; where it isn't
 * available (the server page) the Reinstall verb points back to the registry.
 */
type Action = { label: string; onClick: () => void; testId?: string };

export function McpServerIssueNotice({
  item,
  issues,
  servers,
  onReinstall,
  hideName = false,
  variant = "panel",
  className,
}: {
  item: CatalogItem;
  issues: McpServerIssue[];
  servers: InstalledServer[];
  /** On the server's own page the name is the page title already. */
  hideName?: boolean;
  variant?: "panel" | "row";
  className?: string;
  onReinstall?: (
    item: CatalogItem,
    flaggedInstalls?: Array<{ id: string; name: string }>,
    options?: { alsoReinstallCatalog?: boolean },
  ) => void | Promise<void>;
}) {
  const router = useRouter();
  const [showDetail, setShowDetail] = useState(false);
  const primary = issues[0];
  const { data: autoModeAgents } = useAutoModeAgents();
  const usage = deriveAgentUsage({
    serversForCatalog: servers,
    autoModeAgents,
  });
  const affectedConnections = new Set(
    issues.map((i) => i.serverId).filter(Boolean),
  ).size;
  const since = primary?.since
    ? formatRelativeTimeFromNow(primary.since, { neverLabel: "" })
    : "";
  const guidance = primary ? describeMcpServerIssue(primary) : null;
  const compact = variant === "row";
  // The raw runtime / provider message, for people who want the exact text.
  // OAuth codes get their human name; reinstall reasons already read as a
  // sentence and are shown as the condition instead.
  const rawDetail =
    primary?.kind === "reinstall-required"
      ? null
      : primary?.kind === "needs-reauth" && primary.detail
        ? humanizeOAuthErrorCode(primary.detail)
        : (primary?.detail ?? null);
  // A short one-line message reads fine as one more fact on the meta line;
  // only a long or multi-line one (a stack trace) is worth a disclosure.
  const inlineDetail =
    compact && rawDetail && isShortOneLiner(rawDetail) ? rawDetail : null;
  const disclosedDetail = inlineDetail ? null : rawDetail;
  const detailHref = (tab?: string, serverId?: string) => {
    const params = new URLSearchParams();
    if (tab) params.set("tab", tab);
    if (serverId) params.set("server", serverId);
    const qs = params.toString();
    return `/mcp/registry/${item.id}${qs ? `?${qs}` : ""}`;
  };
  const editHref = `/mcp/registry/${item.id}/edit?step=configuration`;

  // Primary verb clears the issue; secondary is the evidence or the fallback.
  // Both route to the same entry points the card and detail page use.
  const actions = ((): {
    primary?: Action;
    secondary?: Action;
  } => {
    if (!primary || primary.audience !== "you") return {};
    const viewLogs: Action = {
      label: "View logs",
      onClick: () => router.push(detailHref("logs", primary.serverId)),
      testId: `${E2eTestId.McpLogsViewButton}-${item.name}-issue`,
    };
    const editConfig: Action = {
      label: "Edit configuration",
      onClick: () => router.push(editHref),
      testId: `${E2eTestId.McpLogsEditConfigButton}-${item.name}-issue`,
    };
    switch (primary.kind) {
      case "needs-reauth":
        return {
          primary: {
            label: "Re-authenticate",
            onClick: () => router.push(detailHref("credentials")),
          },
        };
      case "reinstall-required":
        return {
          primary: onReinstall
            ? {
                label: "Reinstall",
                onClick: () =>
                  onReinstall(
                    item,
                    servers
                      .filter((s) => s.reinstallRequired)
                      .map((s) => ({ id: s.id, name: s.name })),
                    { alsoReinstallCatalog: !primary.serverId },
                  ),
              }
            : {
                label: "Reinstall from registry",
                onClick: () => router.push("/mcp/registry?tab=attention"),
              },
        };
      case "awaiting-approval":
        return {
          primary: {
            label: "Review image",
            onClick: () => router.push(editHref),
          },
        };
      case "failed-to-start":
      case "not-running":
        return { primary: viewLogs, secondary: editConfig };
      case "stuck-starting":
        return { primary: editConfig, secondary: viewLogs };
      default:
        return {};
    }
  })();

  return (
    <div
      className={cn("rounded-lg border bg-card", className)}
      data-testid={`mcp-registry-attention-row-${item.name}`}
    >
      <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start sm:gap-6">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {!hideName && (
              <>
                <McpCatalogIcon
                  icon={item.icon}
                  catalogId={item.id}
                  size={16}
                />
                <Link
                  href={detailHref()}
                  className="truncate font-medium hover:underline"
                >
                  {item.name}
                </Link>
              </>
            )}
            {!compact &&
              distinctByKind(issues).map((issue) => (
                <McpServerIssueBadge key={issue.kind} issue={issue} />
              ))}
          </div>
          {guidance && (
            <p className="mt-1.5 max-w-prose text-sm">
              <span>{guidance.what}</span>
              {!compact && guidance.fix && (
                <span className="text-muted-foreground"> {guidance.fix}</span>
              )}
            </p>
          )}
          <p
            className={cn(
              "mt-1.5 flex flex-wrap items-center text-xs text-muted-foreground",
              compact ? "gap-x-1.5" : "gap-x-3",
            )}
          >
            {joinFacts(
              [
                usage.total > 0
                  ? `Affects ${usage.total} ${usage.total === 1 ? "agent" : "agents"}`
                  : null,
                affectedConnections > 1
                  ? `${affectedConnections} of ${servers.length} connections`
                  : null,
                since ? `Since ${since}` : null,
                inlineDetail,
              ],
              compact,
            )}
            {disclosedDetail && (
              <button
                type="button"
                className="underline-offset-2 hover:underline"
                aria-expanded={showDetail}
                onClick={() => setShowDetail((v) => !v)}
              >
                {showDetail ? "Hide details" : "Show details"}
              </button>
            )}
          </p>
        </div>
        {(actions.primary || actions.secondary) && (
          <div className="flex shrink-0 items-center gap-2 sm:justify-end sm:pt-0.5">
            {!compact && actions.secondary && (
              <Button
                variant="outline"
                size="sm"
                data-testid={actions.secondary.testId}
                onClick={actions.secondary.onClick}
              >
                {actions.secondary.label}
              </Button>
            )}
            {actions.primary && (
              <Button
                size="sm"
                data-testid={actions.primary.testId}
                onClick={actions.primary.onClick}
              >
                {actions.primary.label}
              </Button>
            )}
          </div>
        )}
        {!actions.primary && !actions.secondary && (
          <div className="flex shrink-0 items-center sm:pt-0.5">
            <Button variant="outline" size="sm" asChild>
              <Link href={detailHref()}>Open</Link>
            </Button>
          </div>
        )}
      </div>
      {showDetail && disclosedDetail && (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words border-t bg-muted/40 px-4 py-2.5 font-mono text-xs text-muted-foreground">
          {disclosedDetail}
        </pre>
      )}
    </div>
  );
}

const INLINE_DETAIL_MAX_CHARS = 80;

function isShortOneLiner(text: string): boolean {
  return !text.includes("\n") && text.trim().length <= INLINE_DETAIL_MAX_CHARS;
}

/**
 * The meta line's facts. In the compact row they read as one sentence
 * fragment separated by middots; the panel keeps them as spaced items.
 */
function joinFacts(facts: Array<string | null>, compact: boolean) {
  const present = facts.filter((f): f is string => !!f);
  return present.map((fact, i) => (
    <span key={fact}>
      {compact && i > 0 && <span aria-hidden="true">· </span>}
      {fact}
    </span>
  ));
}

function distinctByKind(issues: McpServerIssue[]): McpServerIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    if (seen.has(i.kind)) return false;
    seen.add(i.kind);
    return true;
  });
}

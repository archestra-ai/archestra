"use client";

import { E2eTestId } from "@archestra/shared";
import { BellOff, MoreHorizontal, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { typeRole } from "@/lib/design/type-scale";
import { useUnmuteMcpServerAlert } from "@/lib/mcp/mcp-server.query";
import {
  bucketOf,
  canFixInstall,
  describeMcpServerIssue,
  facetIssues,
  type McpServerAttentionFacet,
  type McpServerIssue,
} from "@/lib/mcp/mcp-server-issues";
import { cn } from "@/lib/utils";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import type { CatalogItem, InstalledServer } from "./mcp-server-card";
import { McpServerIssueBadge } from "./mcp-server-issue-badge";
import { MuteAlertDialog } from "./mute-alert-dialog";
import { humanizeOAuthErrorCode } from "./oauth-reauth-detail";
import {
  UninstallServerDialog,
  type UninstallServerInstall,
} from "./uninstall-server-dialog";

/**
 * One server's outstanding issues, explained. Two densities:
 *
 * - `panel` (the server's Overview): the page has no other context, so the
 *   panel also discloses the raw runtime message and names the agents that
 *   depend on the server.
 * - `row` (the registry list): the same diagnosis without the agent usage,
 *   because the row's one number is how many of this server's connections are
 *   affected.
 *
 * Both densities say the same things, and that is the point. The row used to
 * suppress the status pill, the "how to fix it" sentence and the secondary
 * verb on the theory that a section header above it supplied them; there is no
 * section header any more, and there never was one on a narrow screen.
 *
 * Every issue kind in the viewer's own bucket is explained, not just the worst
 * one: a server that needs both a reinstall and a sign-in has two problems,
 * and naming one of them sends the user back a second time for the other.
 *
 * `onReinstall` is the registry list's confirm-dialog flow; where it isn't
 * available (the server page) the Reinstall verb points back to the registry.
 */
type Action = { label: string; onClick: () => void; testId?: string };

export function McpServerIssueNotice({
  item,
  issues,
  servers,
  facet = null,
  onReinstall,
  hideName = false,
  variant = "panel",
  className,
}: {
  item: CatalogItem;
  issues: McpServerIssue[];
  servers: InstalledServer[];
  /**
   * The facet the list is narrowed to, when it is narrowed to one. The row
   * explains that facet's issues, so a row reached under Muted shows what the
   * viewer muted rather than the live issue that kept it in another facet.
   */
  facet?: McpServerAttentionFacet | null;
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
  const [muteOpen, setMuteOpen] = useState(false);
  const [uninstallOpen, setUninstallOpen] = useState(false);
  const { data: session } = useSession();
  const { data: canManageInstalls } = useHasPermissions({
    mcpServerInstallation: ["admin"],
  });
  const unmuteMutation = useUnmuteMcpServerAlert();
  const compact = variant === "row";

  const liveIssues = issues.filter((i) => !i.muted);
  const mutedIssues = issues.filter((i) => i.muted);
  const viewerBucket = bucketOf(liveIssues);
  // What this row is about. Under a facet it is that facet's issues, so the
  // row shows the state the reader narrowed the list to. Off a facet (the
  // server's own page) it is the viewer's own bucket, falling back to the
  // muted issues once every live one has been silenced.
  const relevant = facet
    ? facetIssues(issues, facet)
    : liveIssues.length > 0
      ? viewerBucket === "you"
        ? facetIssues(issues, "you")
        : liveIssues
      : facetIssues(issues, "muted");
  // One pill and one paragraph per kind: three connections failing OAuth are
  // one thing to read, not three. The count below still counts all three.
  const explained = distinctByKind(relevant);
  // Issues are kind-ordered, so the first one the viewer can act on is also
  // the most severe one they can act on.
  const primary = explained.find((i) => i.audience === "you") ?? explained[0];
  const viewerCanAct = primary?.audience === "you" && !primary.muted;

  // Counted before the kinds are collapsed: `needs-reauth` is one issue per
  // connection, so counting the surviving pills would report one connection
  // affected on a server whose every connection is locked out.
  const affectedConnections = new Set(
    relevant.map((i) => i.serverId).filter(Boolean),
  ).size;

  // The connections one kind of issue is about. With exactly one, the row can
  // offer to remove or mute it by name; with several, naming any single one
  // would be a guess, so the row sends the reader to the connections list.
  const connectionsFor = (kind: McpServerIssue["kind"]) => {
    const ids = new Set(
      issues.filter((i) => i.kind === kind).map((i) => i.serverId),
    );
    return servers.filter((s) => ids.has(s.id));
  };
  const reauthConnections = connectionsFor("needs-reauth");
  const removableConnections = [
    ...reauthConnections,
    ...connectionsFor("reinstall-required"),
  ].filter((s, index, all) => all.findIndex((o) => o.id === s.id) === index);
  const viewer = {
    userId: session?.user?.id ?? null,
    canManageInstalls: !!canManageInstalls,
  };
  const removableConnection =
    removableConnections.length === 1 &&
    canFixInstall({ server: removableConnections[0], viewer })
      ? removableConnections[0]
      : null;
  const mutableConnection =
    reauthConnections.length === 1 ? reauthConnections[0] : null;
  const mutedReauth = mutedIssues.find((i) => i.kind === "needs-reauth");

  const detailHref = (tab?: string, serverId?: string) => {
    const params = new URLSearchParams();
    if (tab) params.set("tab", tab);
    if (serverId) params.set("server", serverId);
    const qs = params.toString();
    return `/mcp/registry/${item.id}${qs ? `?${qs}` : ""}`;
  };
  const editHref = `/mcp/registry/${item.id}/edit?step=configuration`;

  // The raw runtime / provider message, for people who want the exact text.
  // OAuth codes get their human name; reinstall reasons already read as a
  // sentence and are shown as the condition instead.
  const rawDetail =
    primary?.kind === "reinstall-required"
      ? null
      : primary?.kind === "needs-reauth" && primary.detail
        ? humanizeOAuthErrorCode(primary.detail)
        : (primary?.detail ?? null);
  const inlineDetail =
    compact && rawDetail && isShortOneLiner(rawDetail) ? rawDetail : null;
  const disclosedDetail = inlineDetail ? null : rawDetail;

  // Primary verb clears the issue; secondary is the evidence or the fallback.
  // Both route to the same entry points the card and detail page use.
  const actions = ((): {
    primary?: Action;
    secondary?: Action;
  } => {
    if (!primary || !viewerCanAct) return {};
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
                onClick: () => router.push("/mcp/registry"),
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

  const overflow: Action[] = [];
  if (mutedReauth) {
    const connection = servers.find((s) => s.id === mutedReauth.serverId);
    if (connection) {
      overflow.push({
        label: "Unmute this alert",
        onClick: () =>
          unmuteMutation.mutate({
            serverId: connection.id,
            serverName: connection.name,
            kind: "needs-reauth",
          }),
      });
    }
  } else if (mutableConnection) {
    // Only `needs-reauth` can be muted, so no other row ever offers it.
    overflow.push({
      label: "Mute this alert",
      onClick: () => setMuteOpen(true),
    });
  }
  if (removableConnection) {
    overflow.push({
      label: "Remove this connection",
      onClick: () => setUninstallOpen(true),
    });
  } else if (removableConnections.length > 1) {
    overflow.push({
      label: "Manage connections",
      onClick: () => router.push(detailHref("credentials")),
    });
  }

  const uninstallInstalls: UninstallServerInstall[] = removableConnection
    ? [
        {
          server: {
            id: removableConnection.id,
            name: removableConnection.name,
          },
          assignedAgents: removableConnection.assignedAgents ?? [],
        },
      ]
    : [];

  // The row's only number, and it names its denominator: "1 of 3 connections"
  // says how much of the server is broken, which "1 connection" does not.
  const facts = [
    servers.length > 0 && affectedConnections > 0
      ? `${affectedConnections} of ${servers.length} ${servers.length === 1 ? "connection" : "connections"} affected`
      : null,
    inlineDetail,
  ];

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
                  className={cn(
                    typeRole({ role: "section-title" }),
                    "truncate hover:underline",
                  )}
                >
                  {item.name}
                </Link>
              </>
            )}
            {explained.map((issue) => (
              <McpServerIssueBadge key={issue.kind} issue={issue} />
            ))}
          </div>
          {explained.map((issue) => {
            const guidance = describeMcpServerIssue(issue);
            const since = issue.since
              ? formatRelativeTimeFromNow(issue.since, { neverLabel: "" })
              : "";
            return (
              <p
                key={issue.kind}
                className={cn(typeRole({ role: "body" }), "mt-1.5 max-w-prose")}
              >
                <span>{guidance.what}</span>
                {since && <span> Failing since {since}.</span>}{" "}
                {issue.audience === "you" && !issue.muted ? (
                  <span className="text-muted-foreground">{guidance.fix}</span>
                ) : (
                  // Somebody else's to fix is not a permission failure, so it
                  // is stated as a fact rather than styled as a refusal.
                  <span className="text-muted-foreground">
                    {issue.muted
                      ? mutedSentence(issue.mutedReason)
                      : guidance.whoActs}
                  </span>
                )}
              </p>
            );
          })}
          <p
            className={cn(
              typeRole({ role: "meta" }),
              "mt-1.5 flex flex-wrap items-center",
              compact ? "gap-x-1.5" : "gap-x-3",
            )}
          >
            {joinFacts(facts, compact)}
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
        <div className="flex shrink-0 items-center gap-2 sm:justify-end sm:pt-0.5">
          {actions.secondary && (
            <Button
              variant="outline"
              size="sm"
              data-testid={actions.secondary.testId}
              onClick={actions.secondary.onClick}
            >
              {actions.secondary.label}
            </Button>
          )}
          {actions.primary ? (
            <Button
              size="sm"
              data-testid={actions.primary.testId}
              onClick={actions.primary.onClick}
            >
              {actions.primary.label}
            </Button>
          ) : (
            <Button variant="outline" size="sm" asChild>
              <Link href={detailHref()}>Open</Link>
            </Button>
          )}
          {overflow.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`More actions for ${item.name}`}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {overflow.map((action) => (
                  <DropdownMenuItem
                    key={action.label}
                    onClick={action.onClick}
                    variant={
                      action.label === "Remove this connection"
                        ? "destructive"
                        : undefined
                    }
                  >
                    {action.label === "Remove this connection" ? (
                      <Trash2 className="h-4 w-4" />
                    ) : (
                      <BellOff className="h-4 w-4" />
                    )}
                    {action.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
      {showDetail && disclosedDetail && (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words border-t bg-muted/40 px-4 py-2.5 font-mono text-xs text-muted-foreground">
          {disclosedDetail}
        </pre>
      )}
      <MuteAlertDialog
        open={muteOpen}
        onClose={() => setMuteOpen(false)}
        server={mutableConnection}
        kind="needs-reauth"
      />
      <UninstallServerDialog
        open={uninstallOpen}
        onClose={() => setUninstallOpen(false)}
        installs={uninstallInstalls}
      />
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

/**
 * The muted state in words. The note is quoted back to the person who wrote
 * it: mutes are per-viewer (the API returns only the caller's own), so this is
 * the only place their own note is ever read back to them.
 */
function mutedSentence(reason: string | null): string {
  const base = "You muted this alert, so it is not counted for you.";
  return reason ? `${base} Your note: "${reason}"` : base;
}

function distinctByKind(issues: McpServerIssue[]): McpServerIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    if (seen.has(i.kind)) return false;
    seen.add(i.kind);
    return true;
  });
}

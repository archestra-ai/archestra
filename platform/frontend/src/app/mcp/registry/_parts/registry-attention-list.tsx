"use client";

import { CheckCircle2 } from "lucide-react";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  bucketOf,
  formatIssueBreakdown,
  type McpServerIssue,
  type McpServerIssueAudience,
  type McpServerIssueSummary,
} from "@/lib/mcp/mcp-server-issues";
import type { CatalogItem, InstalledServer } from "./mcp-server-card";
import { McpServerIssueNotice } from "./mcp-server-issue-notice";

export const ATTENTION_LIST_TEST_ID = "mcp-registry-attention-list";

type Section = {
  audience: McpServerIssueAudience;
  title: string;
  hint: string;
};

// Section order is triage order: what you must do, what somebody else must
// do, what the system is already doing.
const SECTIONS: Section[] = [
  {
    audience: "you",
    title: "Needs your action",
    hint: "Servers you can fix from here.",
  },
  {
    audience: "others",
    title: "Others' connections",
    hint: "Only the connection's owner or an admin can fix these.",
  },
  {
    audience: "system",
    title: "In progress",
    hint: "Nothing to do — the server is starting or waiting on a step.",
  },
];

/**
 * The registry's Needs-attention tab: every catalog item with an outstanding
 * issue, grouped by who has to act, each row naming the server, the cause,
 * who depends on it, and the one action that clears it. Sections with nothing
 * in them are hidden; a clean fleet gets an empty state instead of a list.
 */
export function RegistryAttentionList({
  items,
  installedServers,
  issuesByCatalog,
  summary,
  totalServerCount,
  onReinstall,
}: {
  items: CatalogItem[];
  installedServers: InstalledServer[];
  issuesByCatalog: Map<string, McpServerIssue[]>;
  summary: McpServerIssueSummary;
  /** Catalog items in the registry, for the healthy empty state. */
  totalServerCount: number;
  onReinstall: (
    item: CatalogItem,
    flaggedInstalls?: Array<{ id: string; name: string }>,
    options?: { alsoReinstallCatalog?: boolean },
  ) => void | Promise<void>;
}) {
  const itemsById = new Map(items.map((i) => [i.id, i]));
  const rows = [...issuesByCatalog.entries()]
    .map(([catalogId, issues]) => ({
      item: itemsById.get(catalogId),
      issues,
      bucket: bucketOf(issues),
    }))
    .filter((r): r is typeof r & { item: CatalogItem } => !!r.item)
    .sort((a, b) => a.item.name.localeCompare(b.item.name));

  if (rows.length === 0) {
    return (
      <div className="py-8" data-testid={ATTENTION_LIST_TEST_ID}>
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CheckCircle2 className="text-green-600 dark:text-green-500" />
            </EmptyMedia>
            <EmptyTitle>
              {totalServerCount === 1
                ? "Your MCP server is healthy"
                : `All ${totalServerCount} MCP servers are healthy`}
            </EmptyTitle>
            <EmptyDescription>
              Servers that fail to start, stop running, or need
              re-authentication, a reinstall or an image approval show up here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  return (
    <div className="space-y-8" data-testid={ATTENTION_LIST_TEST_ID}>
      {SECTIONS.map((section) => {
        const sectionRows = rows.filter((r) => r.bucket === section.audience);
        if (sectionRows.length === 0) return null;
        return (
          <section key={section.audience} className="space-y-3">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h3 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
                {section.title}
              </h3>
              <span className="text-xs text-muted-foreground">
                {section.audience === "you" && summary.actionableByKind.length
                  ? formatIssueBreakdown(summary)
                  : section.hint}
              </span>
            </div>
            <div className="space-y-2">
              {sectionRows.map(({ item, issues }) => (
                <McpServerIssueNotice
                  key={item.id}
                  variant="row"
                  item={item}
                  issues={issues.filter((i) =>
                    section.audience === "system"
                      ? true
                      : i.audience === section.audience,
                  )}
                  servers={installedServers.filter(
                    (s) => s.catalogId === item.id,
                  )}
                  onReinstall={onReinstall}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

// ===== Internal pieces =====

"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { Bot } from "lucide-react";
import { useMemo, useState } from "react";
import { QueryLoadError } from "@/components/query-load-error";
import { scopeLabel } from "@/components/scope-vocabulary";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TablePagination } from "@/components/ui/table-pagination";
import { type AgentOwner, describeAgentOwner } from "@/lib/agent-owner-label";
import { useSession } from "@/lib/auth/auth.query";
import { useMcpServerAgentUsage } from "@/lib/mcp/mcp-agent-usage.query";
import { agentTypeLabel, deriveAgentUsage } from "./mcp-server-agent-usage";

type McpServerFromApi = archestraApiTypes.GetMcpServersResponses["200"][number];

/**
 * Read-only view of everything that can reach this MCP server, across all of
 * its installs. Deliberately not editable: access is granted from the agent
 * side (tool assignment or auto mode), so this is the inverse index of that.
 */
export function McpServerUsageTab({
  serversForCatalog,
  autoModeAgents,
  page,
  pagination: controlledPagination,
  onPaginationChange,
}: {
  serversForCatalog: McpServerFromApi[];
  page?: archestraApiTypes.GetMcpServerAgentUsageResponses["200"][number];
  pagination?: { pageIndex: number; pageSize: number };
  onPaginationChange?: (value: { pageIndex: number; pageSize: number }) => void;
  /** Org-wide auto-mode roster, fetched once by the parent (useAutoModeAgents). */
  autoModeAgents:
    | archestraApiTypes.GetMcpServerAutoModeAgentsResponses["200"]
    | undefined;
}) {
  const derived = useMemo(
    () => deriveAgentUsage({ serversForCatalog, autoModeAgents }),
    [serversForCatalog, autoModeAgents],
  );
  const all = page?.data ?? derived.all;
  const total = page?.pagination.total ?? all.length;
  const assignedCount = page?.assignedCount ?? derived.assigned.length;
  const autoCount = page?.autoCount ?? derived.autoOnly.length;
  const [localPagination, setLocalPagination] = useState({
    pageIndex: 0,
    pageSize: 20,
  });
  const pagination = controlledPagination ?? localPagination;
  const setPagination = onPaginationChange ?? setLocalPagination;
  // A refreshed roster can remove the last page while it is being viewed.
  const pageIndex = Math.min(
    pagination.pageIndex,
    Math.max(0, Math.ceil(total / pagination.pageSize) - 1),
  );
  const visibleAgents = page
    ? all
    : all.slice(
        pageIndex * pagination.pageSize,
        (pageIndex + 1) * pagination.pageSize,
      );
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;

  if (total === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-12 text-center">
        <Bot className="h-6 w-6 text-muted-foreground" />
        <p className="text-sm font-medium">
          No agents or MCP gateways use this server yet
        </p>
        <p className="max-w-md text-sm text-muted-foreground">
          Agents and MCP gateways reach a server when their tool access is All,
          or Manual with some of this server's tools picked.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {total} {total === 1 ? "agent or gateway" : "agents and gateways"} can
        reach this server — {assignedCount} with Manual tool access, {autoCount}{" "}
        with All.
      </p>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead>Tool access</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleAgents.map((agent) => (
              <TableRow key={agent.id}>
                <TableCell className="font-medium">{agent.name}</TableCell>
                <TableCell className="text-muted-foreground">
                  {agentTypeLabel(agent.agentType)}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  <OwnerCell owner={describeAgentOwner(agent, currentUserId)} />
                </TableCell>
                <TableCell>
                  {agent.access === "assigned" ? (
                    <Badge variant="secondary">Manual</Badge>
                  ) : (
                    <Badge variant="outline">All</Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <TablePagination
        pageIndex={pageIndex}
        pageSize={pagination.pageSize}
        total={total}
        onPaginationChange={setPagination}
      />
    </div>
  );
}

/** Fetch only the selected Usage page; the legacy renderer stays reusable. */
export function McpServerPagedUsageTab({ catalogId }: { catalogId: string }) {
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 20 });
  const [search, setSearch] = useState("");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const query = useMcpServerAgentUsage({
    catalogIds: [catalogId],
    limit: pagination.pageSize,
    offset: pagination.pageIndex * pagination.pageSize,
    search,
    sortDirection,
  });
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Input
          placeholder="Search agents or owners"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPagination((current) => ({ ...current, pageIndex: 0 }));
          }}
        />
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
            setPagination((current) => ({ ...current, pageIndex: 0 }));
          }}
        >
          <span>
            {sortDirection === "asc" ? "Name: A to Z" : "Name: Z to A"}
          </span>
        </Button>
      </div>
      {query.isLoadingError ? (
        <QueryLoadError
          title="Could not load agent usage"
          onRetry={() => query.refetch()}
        />
      ) : query.isPending ? (
        <p className="text-sm text-muted-foreground">Loading agent usage…</p>
      ) : query.data?.[0] ? (
        <McpServerUsageTab
          serversForCatalog={[]}
          autoModeAgents={undefined}
          page={query.data[0]}
          pagination={pagination}
          onPaginationChange={setPagination}
        />
      ) : null}
    </div>
  );
}

/**
 * One cell, one question: whose agent is this.
 *
 * Every branch is a distinct answer. The personal scope label is deliberately
 * absent — this column used to print "Personal" whenever the owner's email was
 * missing, which said nothing about ownership while looking exactly like an
 * answer, and left the viewer's own agents indistinguishable from a departed
 * colleague's.
 */
function OwnerCell({ owner }: { owner: AgentOwner }) {
  switch (owner.kind) {
    case "self":
      return (
        <span
          className="font-medium text-foreground"
          // The email is still the identity behind "You"; keep it reachable
          // for anyone reconciling this table against a list of accounts.
          title={owner.email ?? undefined}
        >
          You
        </span>
      );
    case "user":
      return <span>{owner.email}</span>;
    case "deleted":
      return (
        <span
          className="italic"
          title="The account that owned this agent has been deleted."
        >
          Deleted user
        </span>
      );
    case "scope":
      // A team- or org-scoped agent belongs to the team or the organization,
      // so the scope is the owner. Spelled the way every scope pill spells it,
      // so this column never shows the raw `org` enum.
      return <span>{scopeLabel(owner.scope)}</span>;
  }
}

"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { Bot } from "lucide-react";
import { scopeLabel } from "@/components/scope-vocabulary";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { type AgentOwner, describeAgentOwner } from "@/lib/agent-owner-label";
import { useSession } from "@/lib/auth/auth.query";
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
}: {
  serversForCatalog: McpServerFromApi[];
  /** Org-wide auto-mode roster, fetched once by the parent (useAutoModeAgents). */
  autoModeAgents:
    | archestraApiTypes.GetMcpServerAutoModeAgentsResponses["200"]
    | undefined;
}) {
  const { all, assigned, autoOnly } = deriveAgentUsage({
    serversForCatalog,
    autoModeAgents,
  });
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;

  if (all.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-12 text-center">
        <Bot className="h-6 w-6 text-muted-foreground" />
        <p className="text-sm font-medium">No agents use this server yet</p>
        <p className="max-w-md text-sm text-muted-foreground">
          Agents reach a server by having its tools assigned, or by running in
          auto mode with access to all tools.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {all.length} {all.length === 1 ? "agent" : "agents"} can reach this
        server — {assigned.length} with assigned tools, {autoOnly.length} in
        auto mode.
      </p>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead>Access</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {all.map((agent) => (
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
                    <Badge variant="secondary">Assigned tools</Badge>
                  ) : (
                    <Badge variant="outline">Auto — all tools</Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
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

"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { Bot } from "lucide-react";
import { scopeLabel } from "@/components/scope-badge";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  agentOwnerLabel,
  agentTypeLabel,
  deriveAgentUsage,
} from "./mcp-server-agent-usage";

type McpServerFromApi = archestraApiTypes.GetMcpServersResponses["200"][number];

/**
 * Read-only view of everything that can reach this MCP server, across all of
 * its installs. Deliberately not editable: access is granted from the agent
 * side (tool assignment or auto mode), so this is the inverse index of that.
 */
export function McpServerUsageTab({
  serversForCatalog,
}: {
  serversForCatalog: McpServerFromApi[];
}) {
  const { all, assigned, autoOnly } = deriveAgentUsage(serversForCatalog);

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
            {all.map((agent) => {
              const owner = agentOwnerLabel(agent);
              return (
                <TableRow key={agent.id}>
                  <TableCell className="font-medium">{agent.name}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {agentTypeLabel(agent.agentType)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {/*
                      Personal agents are seeded per member and share a name, so
                      the owner is what tells them apart. Org- and team-scoped
                      agents belong to everyone, hence the scope label instead —
                      spelled out the way every scope pill spells it, so this
                      column never shows the raw `org` enum.
                    */}
                    {owner ? (
                      <span>{owner}</span>
                    ) : (
                      <span>{scopeLabel(agent.scope)}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {agent.access === "assigned" ? (
                      <Badge variant="secondary">Assigned tools</Badge>
                    ) : (
                      <Badge variant="outline">Auto — all tools</Badge>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

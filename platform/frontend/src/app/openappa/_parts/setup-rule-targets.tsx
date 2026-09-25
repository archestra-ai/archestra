"use client";

import { useState } from "react";
import { AgentIcon } from "@/components/agent-icon";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { QueryLoadError } from "@/components/query-load-error";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  type CoverageEntity,
  useCoverageEntitiesForTools,
} from "@/lib/openappa-coverage.query";
import { entityTypeLabel } from "./entities-table";
import type { PickedTool } from "./setup-rule-flow";

const FIRST_ROWS = 5;

/**
 * The policy targets table cut down to the rule's tools: which agents, MCP
 * gateways and MCP servers reach them, so the review shows where the rule
 * will ask, naming the picked tools each one reaches. With two tools,
 * targets that reach both come first.
 */
export function RuleTargets({ tools }: { tools: PickedTool[] }) {
  const [showAll, setShowAll] = useState(false);
  const { targets, isPending, isError, refetch } = useCoverageEntitiesForTools(
    tools.map((tool) => tool.toolId),
  );
  const sorted = [...targets].sort(
    (a, b) =>
      b.toolIds.length - a.toolIds.length ||
      Number(a.entity.type === "mcp_server") -
        Number(b.entity.type === "mcp_server") ||
      a.entity.name.localeCompare(b.entity.name),
  );
  const shown = showAll ? sorted : sorted.slice(0, FIRST_ROWS);
  const callers = targets.filter(
    (target) => target.entity.type !== "mcp_server",
  ).length;

  return (
    <section aria-labelledby="setup-rule-targets" className="space-y-3">
      <div className="max-w-[65ch] space-y-1">
        <h3 id="setup-rule-targets" className="text-sm font-medium">
          Where your rule applies
        </h3>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {isPending || isError || callers > 0
            ? "These agents, MCP gateways and MCP servers can call the tools in your rule, so their calls follow it."
            : "No agent or MCP gateway can call these tools yet. The rule applies as soon as one can."}
        </p>
      </div>
      {isPending ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : isError ? (
        <QueryLoadError
          className="h-auto rounded-lg border py-6"
          title="Could not load policy targets"
          onRetry={refetch}
        />
      ) : targets.length > 0 ? (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[35%]">Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Tools</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map(({ entity, toolIds }) => (
                <TableRow key={entity.id}>
                  <TableCell>
                    <span className="flex min-w-0 items-center gap-2">
                      <TargetIcon entity={entity} />
                      <span className="truncate font-medium">
                        {entity.name}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {entityTypeLabel(entity.type)}
                  </TableCell>
                  <TableCell>
                    {/* One line, so a row reaching both tools is as tall as the rest. */}
                    <ToolNames
                      names={tools
                        .filter((tool) => toolIds.includes(tool.toolId))
                        .map((tool) => tool.name)}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {sorted.length > FIRST_ROWS && (
            <div className="border-t px-2 py-1.5">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowAll(!showAll)}
              >
                {showAll ? "Show fewer" : `Show all ${sorted.length}`}
              </Button>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

function TargetIcon({ entity }: { entity: CoverageEntity }) {
  return entity.type === "mcp_server" ? (
    <McpCatalogIcon icon={entity.icon} catalogId={entity.id} size={18} />
  ) : (
    <AgentIcon icon={entity.icon} fallbackType={entity.type} size={18} />
  );
}

function ToolNames({ names }: { names: string[] }) {
  const text = names.join(", ");
  return (
    <code className="block truncate font-mono text-xs" title={text}>
      {text}
    </code>
  );
}

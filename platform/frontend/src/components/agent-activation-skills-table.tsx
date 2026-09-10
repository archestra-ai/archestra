"use client";

import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAgentActivationSkills } from "@/lib/agent-skills.query";

export function AgentActivationSkillsTable({
  agentId,
  environmentId,
}: {
  agentId?: string;
  environmentId?: string | null;
}) {
  const { data, isPending, isError } = useAgentActivationSkills({
    agentId,
    environmentId,
  });

  return (
    <div className="overflow-hidden rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[70%]">Skill</TableHead>
            <TableHead className="w-[30%]">Visibility</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isPending ? (
            <MessageRow>Loading skills…</MessageRow>
          ) : isError ? (
            <MessageRow tone="error">
              Could not load skills. Try reopening this page.
            </MessageRow>
          ) : !data?.enabled ? (
            <MessageRow>Skills are not enabled for this agent.</MessageRow>
          ) : data.skills.length === 0 ? (
            <MessageRow>
              No skills are available to you in this environment.
            </MessageRow>
          ) : (
            data.skills.map((skill) => (
              <TableRow key={referenceKey(skill.reference)}>
                <TableCell>
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-baseline gap-2">
                      <p className="truncate font-medium" title={skill.name}>
                        {skill.name}
                      </p>
                      <SourceBadge
                        source={skill.reference.source}
                        providerName={skill.providerName}
                      />
                    </div>
                    <p
                      className="line-clamp-2 text-xs text-muted-foreground"
                      title={skill.description}
                    >
                      {skill.description}
                    </p>
                  </div>
                </TableCell>
                <TableCell>
                  <ResourceVisibilityBadge scope={skill.scope} scopeOnly />
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function MessageRow({
  children,
  tone = "muted",
}: {
  children: React.ReactNode;
  tone?: "muted" | "error";
}) {
  return (
    <TableRow>
      <TableCell
        colSpan={2}
        className={
          tone === "error" ? "text-destructive" : "text-muted-foreground"
        }
      >
        {children}
      </TableCell>
    </TableRow>
  );
}

function SourceBadge({
  source,
  providerName,
}: {
  source: "native" | "external_mcp" | "plugin";
  providerName: string | null;
}) {
  const sourceName = sourceLabel(source);
  const label = providerName ? `${providerName} · ${sourceName}` : sourceName;
  return (
    <Badge
      variant="secondary"
      title={label}
      className="inline-flex max-w-56 shrink items-center gap-1 overflow-hidden font-normal"
    >
      {providerName && <span className="truncate">{providerName}</span>}
      {providerName && (
        <span aria-hidden className="shrink-0 text-muted-foreground">
          ·
        </span>
      )}
      <span className="shrink-0">{sourceName}</span>
    </Badge>
  );
}

function sourceLabel(source: "native" | "external_mcp" | "plugin") {
  switch (source) {
    case "native":
      return "Skill library";
    case "external_mcp":
      return "MCP";
    case "plugin":
      return "Plugin";
  }
}

function referenceKey(
  reference:
    | { source: "native"; skillId: string }
    | { source: "external_mcp"; mcpServerId: string; uri: string }
    | { source: "plugin"; pluginId: string; skillPath: string },
) {
  switch (reference.source) {
    case "native":
      return `native:${reference.skillId}`;
    case "external_mcp":
      return `external:${reference.mcpServerId}:${reference.uri}`;
    case "plugin":
      return `plugin:${reference.pluginId}:${reference.skillPath}`;
  }
}

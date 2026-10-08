"use client";

import { CLIENT_FILTER_OPTIONS } from "@archestra/shared";
import { Users, Wrench } from "lucide-react";
import { ClientSourceBadge } from "@/components/client-source-badge";
import { TableCard, TableCardGrid } from "@/components/table-card-view";
import type { DetectedMcpServer } from "@/lib/mcp/detected-mcp-server.query";

/**
 * The MCP servers people connected to their own clients, which the LLM proxy
 * saw declaring tools. They are not installed here, so the cards carry no
 * install or settings actions; the heading names the group for the reader
 * scanning past the catalog list above.
 */
export function DetectedServersSection({
  servers,
}: {
  servers: DetectedMcpServer[];
}) {
  if (servers.length === 0) return null;

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-base font-semibold">Detected</h2>
        <p className="text-sm text-muted-foreground">
          Servers people connected directly to their coding clients, seen by the
          LLM proxy.
        </p>
      </div>
      <TableCardGrid>
        {servers.map((server) => (
          <DetectedServerCard key={server.id} server={server} />
        ))}
      </TableCardGrid>
    </section>
  );
}

function DetectedServerCard({ server }: { server: DetectedMcpServer }) {
  const client = CLIENT_FILTER_OPTIONS.find(
    (option) => option.value === server.clientFamily,
  );

  return (
    <TableCard
      title={server.label}
      description={server.id}
      density="compact"
      testId={`detected-mcp-server-${server.id}`}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground">
        {client && <ClientSourceBadge client={client} className="shrink-0" />}
        <div className="flex shrink-0 items-center gap-1">
          <Wrench className="h-3.5 w-3.5" />
          <span>{server.tools.length}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Users className="h-3.5 w-3.5" />
          <span>{server.observerCount}</span>
        </div>
      </div>
    </TableCard>
  );
}

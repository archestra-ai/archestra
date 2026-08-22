"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import Link from "next/link";
import { ConnectorStatusDot } from "@/app/knowledge/knowledge-bases/_parts/connector-enabled-dot";
import { ConnectorTypeIcon } from "@/app/knowledge/knowledge-bases/_parts/connector-icons";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type KnowledgeBaseItem =
  archestraApiTypes.GetKnowledgeBasesResponses["200"]["data"][number];
type KnowledgeBaseConnector = KnowledgeBaseItem["connectors"][number];
type ConnectorItem =
  archestraApiTypes.GetConnectorsResponses["200"]["data"][number];

/**
 * One connector as it appears on its knowledge base: type glyph, name, and the
 * sync dot the connectors list uses, linking to the connector's own page —
 * plus the two per-connector actions the expandable sub-table used to own
 * (edit it, unassign it from this knowledge base), behind a menu so the chip
 * stays a chip.
 *
 * `detail` is absent only until the connectors query settles, or for a
 * connector outside the fetched window, in which case the dot is left off
 * rather than guessed at.
 */
export function ConnectorChip({
  connector,
  detail,
  onEdit,
  onRemove,
}: {
  connector: KnowledgeBaseConnector;
  detail: ConnectorItem | undefined;
  /** Absent while the full connector record has not loaded — nothing to edit. */
  onEdit: (connector: ConnectorItem) => void;
  onRemove: (connectorId: string) => void;
}) {
  return (
    <span className="inline-flex max-w-full items-center rounded-md border text-xs">
      <Link
        href={`/knowledge/connectors/${connector.id}?from=knowledge-bases`}
        className="inline-flex min-w-0 max-w-[220px] items-center gap-1.5 rounded-l-md py-1 pl-2 pr-1.5 transition-colors hover:bg-muted"
        title={connector.name}
        onClick={(event) => event.stopPropagation()}
      >
        {detail && (
          <ConnectorStatusDot
            enabled={detail.enabled}
            lastSyncStatus={detail.lastSyncStatus}
          />
        )}
        <ConnectorTypeIcon
          type={connector.connectorType}
          className="h-3.5 w-3.5 shrink-0"
        />
        <span className="truncate">{connector.name}</span>
      </Link>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 rounded-l-none rounded-r-md border-l text-muted-foreground"
                aria-label={`Actions for ${connector.name}`}
                onClick={(event) => event.stopPropagation()}
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>Connector actions</TooltipContent>
        </Tooltip>
        <DropdownMenuContent
          align="start"
          onClick={(event) => event.stopPropagation()}
        >
          <DropdownMenuItem
            disabled={!detail}
            onClick={() => detail && onEdit(detail)}
          >
            <Pencil className="h-4 w-4" />
            Edit connector
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onClick={() => onRemove(connector.id)}
          >
            <Trash2 className="h-4 w-4" />
            Remove from knowledge base
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}

"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { Bot, Database, FileText, Plug, Plus } from "lucide-react";
import type { MouseEventHandler } from "react";
import { ConnectorChip } from "@/app/knowledge/knowledge-bases/_parts/connector-chip";
import { COLLECTION_CARD_HOVER_CLASSNAME } from "@/components/table-card-view";
import {
  type TableRowAction,
  TableRowActions,
} from "@/components/table-row-actions";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type KnowledgeBaseItem =
  archestraApiTypes.GetKnowledgeBasesResponses["200"]["data"][number];
type ConnectorItem =
  archestraApiTypes.GetConnectorsResponses["200"]["data"][number];

/** How many connectors a card names before the rest collapse into a count. */
const MAX_VISIBLE_CONNECTORS = 4;

/**
 * One knowledge base, whole, on a card: what it holds, what feeds it, and who
 * uses it.
 *
 * This replaced a table whose real content was hidden behind a per-row expand
 * chevron — the outer row could only ever say "2 connectors", and finding out
 * which two meant opening a second table nested inside the first. Here the
 * connectors ARE the card: named, status-dotted, and each a link to its own
 * page, which is where anything beyond "is it healthy" was always going to
 * happen.
 */
export function KnowledgeBaseCard({
  knowledgeBase,
  connectorsById,
  selected,
  onSelectedChange,
  onSelectionClick,
  actions,
  onAddConnector,
  onEditConnector,
  onRemoveConnector,
}: {
  knowledgeBase: KnowledgeBaseItem;
  /** Full connector records, for sync status the KB payload does not carry. */
  connectorsById: Map<string, ConnectorItem>;
  selected: boolean;
  onSelectedChange: (selected: boolean) => void;
  onSelectionClick?: MouseEventHandler<HTMLButtonElement>;
  actions: TableRowAction[];
  onAddConnector: () => void;
  onEditConnector: (connector: ConnectorItem) => void;
  onRemoveConnector: (connectorId: string) => void;
}) {
  const { connectors, assignedAgents, totalDocsIndexed } = knowledgeBase;
  const visibleConnectors = connectors.slice(0, MAX_VISIBLE_CONNECTORS);
  const hiddenConnectors = connectors.slice(MAX_VISIBLE_CONNECTORS);

  return (
    <div
      className={cn(
        "flex h-full flex-col gap-3 rounded-lg border p-4 transition-colors",
        selected
          ? "border-primary bg-primary/5"
          : COLLECTION_CARD_HOVER_CLASSNAME,
      )}
    >
      <div className="flex items-start gap-3">
        <Checkbox
          className="mt-1"
          checked={selected}
          onCheckedChange={(value) => onSelectedChange(!!value)}
          onClick={onSelectionClick}
          aria-label={`Select ${knowledgeBase.name}`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Database className="h-4 w-4 shrink-0 text-muted-foreground" />
            <h3 className="truncate font-medium" title={knowledgeBase.name}>
              {knowledgeBase.name}
            </h3>
          </div>
          {knowledgeBase.description && (
            <p
              className="mt-1 line-clamp-2 text-xs text-muted-foreground"
              title={knowledgeBase.description}
            >
              {knowledgeBase.description}
            </p>
          )}
        </div>
        <TableRowActions actions={actions} itemName={knowledgeBase.name} />
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <CardStat
          icon={<FileText className="h-3.5 w-3.5" />}
          value={totalDocsIndexed.toLocaleString()}
          label={totalDocsIndexed === 1 ? "document" : "documents"}
        />
        <CardStat
          icon={<Plug className="h-3.5 w-3.5" />}
          value={connectors.length}
          label={connectors.length === 1 ? "connector" : "connectors"}
        />
        <CardStat
          icon={<Bot className="h-3.5 w-3.5" />}
          value={assignedAgents.length}
          label={assignedAgents.length === 1 ? "agent" : "agents"}
        />
      </div>

      <div className="mt-auto flex flex-wrap items-center gap-1.5 border-t pt-3">
        {connectors.length === 0 ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
            onClick={onAddConnector}
          >
            <Plus className="h-3.5 w-3.5" />
            Add a connector — this knowledge base is empty
          </Button>
        ) : (
          <>
            {visibleConnectors.map((connector) => (
              <ConnectorChip
                key={connector.id}
                connector={connector}
                detail={connectorsById.get(connector.id)}
                onEdit={onEditConnector}
                onRemove={onRemoveConnector}
              />
            ))}
            {hiddenConnectors.length > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="cursor-default rounded-md border px-2 py-1 text-xs text-muted-foreground">
                    +{hiddenConnectors.length} more
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  <div className="space-y-0.5">
                    {hiddenConnectors.map((connector) => (
                      <div key={connector.id}>{connector.name}</div>
                    ))}
                  </div>
                </TooltipContent>
              </Tooltip>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ===== Internal pieces =====

function CardStat({
  icon,
  value,
  label,
}: {
  icon: React.ReactNode;
  value: number | string;
  label: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {icon}
      <span className="font-medium text-foreground tabular-nums">{value}</span>
      <span>{label}</span>
    </span>
  );
}

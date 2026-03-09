"use client";

import { Database } from "lucide-react";
import { ConnectorTypeIcon } from "@/app/knowledge/knowledge-bases/_parts/connector-icons";
import { OverlappedIcons } from "@/components/ui/overlapped-icons";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useConnectors } from "@/lib/connector.query";
import { useKnowledgeBases } from "@/lib/knowledge-base.query";

interface KnowledgeBaseIndicatorProps {
  knowledgeBaseIds: string[];
  connectorIds: string[];
  /** When true, renders KB details inline without popover/click interaction */
  static?: boolean;
}

export function KnowledgeBaseIndicator({
  knowledgeBaseIds,
  connectorIds,
  static: isStatic = false,
}: KnowledgeBaseIndicatorProps) {
  const { data: knowledgeBasesData } = useKnowledgeBases();
  const { data: connectorsData } = useConnectors();
  const allKnowledgeBases = knowledgeBasesData?.data ?? [];
  const allConnectors = connectorsData?.data ?? [];

  const matchedKbs = allKnowledgeBases.filter((k) =>
    knowledgeBaseIds.includes(k.id),
  );
  const matchedConnectors = allConnectors.filter((c) =>
    connectorIds.includes(c.id),
  );

  const totalSources = matchedKbs.length + matchedConnectors.length;
  if (totalSources === 0) return null;

  // Collect all unique connector types for the overlapped icons
  const kbConnectorTypes = matchedKbs.flatMap(
    (kb) => kb.connectors?.map((c) => c.connectorType) ?? [],
  );
  const directConnectorTypes = matchedConnectors.map((c) => c.connectorType);
  const uniqueConnectorTypes = [
    ...new Set([...kbConnectorTypes, ...directConnectorTypes]),
  ];

  const connectorIcons = uniqueConnectorTypes.map((type) => ({
    key: type,
    icon: <ConnectorTypeIcon type={type} className="h-full w-full" />,
    tooltip: type,
  }));

  const kbDetails = (
    <div className="space-y-2">
      {matchedKbs.map((kb) => {
        const connectors = kb.connectors ?? [];
        const connectorTypes = [
          ...new Set(connectors.map((c) => c.connectorType)),
        ];
        return (
          <div key={kb.id} className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium truncate">{kb.name}</span>
            {connectorTypes.length > 0 && (
              <OverlappedIcons
                icons={connectorTypes.map((type) => ({
                  key: type,
                  icon: (
                    <ConnectorTypeIcon type={type} className="h-full w-full" />
                  ),
                  tooltip: type,
                }))}
                maxVisible={3}
                size="sm"
              />
            )}
          </div>
        );
      })}
      {matchedConnectors.map((connector) => (
        <div key={connector.id} className="flex items-center gap-2 text-sm">
          <ConnectorTypeIcon
            type={connector.connectorType}
            className="h-4 w-4 shrink-0"
          />
          <span className="truncate">{connector.name}</span>
        </div>
      ))}
    </div>
  );

  if (isStatic) {
    return (
      <div className="flex items-center gap-1.5 h-8 rounded-md px-2.5">
        <Database className="size-4 text-muted-foreground shrink-0" />
        {connectorIcons.length > 0 && (
          <OverlappedIcons icons={connectorIcons} maxVisible={5} size="sm" />
        )}
      </div>
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1.5 h-8 rounded-md px-2.5 cursor-pointer hover:bg-accent transition-colors"
        >
          <Database className="size-4 text-muted-foreground shrink-0" />
          {connectorIcons.length > 0 && (
            <OverlappedIcons icons={connectorIcons} maxVisible={5} size="sm" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-3" side="top" align="start">
        <div className="space-y-3">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Knowledge Sources
          </p>
          {kbDetails}
        </div>
      </PopoverContent>
    </Popover>
  );
}

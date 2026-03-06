"use client";

import { Database } from "lucide-react";
import { ConnectorTypeIcon } from "@/app/knowledge/knowledge-bases/_parts/connector-icons";
import { Button } from "@/components/ui/button";
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
}

export function KnowledgeBaseIndicator({
  knowledgeBaseIds,
  connectorIds,
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

  // Collect all unique connector types for the pill icons
  const kbConnectorTypes = matchedKbs.flatMap(
    (kb) => kb.connectors?.map((c) => c.connectorType) ?? [],
  );
  const directConnectorTypes = matchedConnectors.map((c) => c.connectorType);
  const uniqueConnectorTypes = [
    ...new Set([...kbConnectorTypes, ...directConnectorTypes]),
  ];

  const label =
    totalSources === 1
      ? (matchedKbs[0]?.name ?? matchedConnectors[0]?.name)
      : `${totalSources} knowledge sources`;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2 gap-1.5 text-xs"
        >
          <Database className="h-3 w-3" />
          <span className="truncate max-w-[150px]">{label}</span>
          {uniqueConnectorTypes.length > 0 && (
            <div className="flex items-center gap-0.5 ml-0.5">
              {uniqueConnectorTypes.map((type) => (
                <ConnectorTypeIcon
                  key={type}
                  type={type}
                  className="h-3.5 w-3.5"
                />
              ))}
            </div>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-3" side="top" align="start">
        <div className="space-y-3">
          {matchedKbs.length > 0 && (
            <div className="space-y-2">
              {matchedKbs.length > 0 && matchedConnectors.length > 0 && (
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Knowledge Bases
                </p>
              )}
              {matchedKbs.map((kb) => {
                const connectors = kb.connectors ?? [];
                return (
                  <div key={kb.id} className="space-y-1.5">
                    <p className="text-sm font-medium">{kb.name}</p>
                    {connectors.length > 0 && (
                      <div className="space-y-1">
                        {connectors.map((connector) => (
                          <div
                            key={connector.id}
                            className="flex items-center gap-2 text-sm"
                          >
                            <ConnectorTypeIcon
                              type={connector.connectorType}
                              className="h-4 w-4"
                            />
                            <span>{connector.name}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {matchedConnectors.length > 0 && (
            <div className="space-y-2">
              {matchedKbs.length > 0 && (
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Direct Connectors
                </p>
              )}
              {matchedConnectors.map((connector) => (
                <div
                  key={connector.id}
                  className="flex items-center gap-2 text-sm"
                >
                  <ConnectorTypeIcon
                    type={connector.connectorType}
                    className="h-4 w-4"
                  />
                  <span>{connector.name}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

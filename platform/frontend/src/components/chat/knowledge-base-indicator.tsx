"use client";

import { ConnectorTypeIcon } from "@/app/knowledge-bases/_parts/connector-icons";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useKnowledgeBases } from "@/lib/knowledge-base.query";
import { Database } from "lucide-react";

interface KnowledgeBaseIndicatorProps {
  knowledgeBaseId: string;
}

export function KnowledgeBaseIndicator({
  knowledgeBaseId,
}: KnowledgeBaseIndicatorProps) {
  const { data: knowledgeBasesData } = useKnowledgeBases();
  const knowledgeBases = knowledgeBasesData?.data ?? [];
  const kb = knowledgeBases.find((k) => k.id === knowledgeBaseId);

  if (!kb) return null;

  const connectors = kb.connectors ?? [];

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2 gap-1.5 text-xs"
        >
          <Database className="h-3 w-3" />
          <span className="truncate max-w-[150px]">{kb.name}</span>
          {connectors.length > 0 && (
            <div className="flex items-center gap-0.5 ml-0.5">
              {[...new Set(connectors.map((c) => c.connectorType))].map(
                (type) => (
                  <ConnectorTypeIcon
                    key={type}
                    type={type}
                    className="h-3.5 w-3.5"
                  />
                ),
              )}
            </div>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-3" side="top" align="start">
        <div className="space-y-2">
          <p className="text-sm font-medium">{kb.name}</p>
          {connectors.length > 0 ? (
            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground">Connectors</p>
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
          ) : (
            <p className="text-xs text-muted-foreground">No connectors</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

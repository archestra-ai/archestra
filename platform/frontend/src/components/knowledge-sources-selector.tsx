"use client";

import { CheckIcon, ChevronDown } from "lucide-react";
import { ConnectorTypeIcon } from "@/app/knowledge/knowledge-bases/_parts/connector-icons";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { OverlappedIcons } from "@/components/ui/overlapped-icons";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

type KnowledgeBaseOption = {
  id: string;
  name: string;
  description?: string | null;
  connectors?: Array<{ connectorType: string }> | null;
};

type ConnectorOption = {
  id: string;
  name: string;
  description?: string | null;
  connectorType: string;
};

export function KnowledgeSourcesSelector({
  knowledgeBases,
  selectedKnowledgeBaseIds,
  onKnowledgeBaseIdsChange,
  connectors = [],
  selectedConnectorIds = [],
  onConnectorIdsChange,
  disabled,
}: {
  knowledgeBases: KnowledgeBaseOption[];
  selectedKnowledgeBaseIds: string[];
  onKnowledgeBaseIdsChange: (ids: string[]) => void;
  connectors?: ConnectorOption[];
  selectedConnectorIds?: string[];
  onConnectorIdsChange?: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const totalSelected =
    selectedKnowledgeBaseIds.length + selectedConnectorIds.length;

  return (
    <Popover modal>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          className="w-full justify-between font-normal"
        >
          {totalSelected === 0
            ? "Select connectors or knowledge bases"
            : `${totalSelected} source${totalSelected > 1 ? "s" : ""} selected`}
          <ChevronDown className="ml-2 h-4 w-4 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-96 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search knowledge sources..." />
          <CommandList>
            <CommandEmpty>No knowledge sources found.</CommandEmpty>
            {knowledgeBases.length > 0 && (
              <CommandGroup heading="Knowledge Bases">
                {knowledgeBases.map((knowledgeBase) => {
                  const isSelected = selectedKnowledgeBaseIds.includes(
                    knowledgeBase.id,
                  );
                  const connectorTypes = [
                    ...new Set<string>(
                      knowledgeBase.connectors?.map(
                        (connector) => connector.connectorType,
                      ) ?? [],
                    ),
                  ];
                  return (
                    <CommandItem
                      key={knowledgeBase.id}
                      value={knowledgeBase.name}
                      className="data-[selected=true]:bg-transparent"
                      onSelect={() => {
                        onKnowledgeBaseIdsChange(
                          isSelected
                            ? selectedKnowledgeBaseIds.filter(
                                (id) => id !== knowledgeBase.id,
                              )
                            : [...selectedKnowledgeBaseIds, knowledgeBase.id],
                        );
                      }}
                    >
                      <CheckIcon
                        className={cn(
                          "mr-2 h-4 w-4 shrink-0",
                          isSelected ? "opacity-100" : "opacity-0",
                        )}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm">
                          {knowledgeBase.name}
                        </div>
                        {knowledgeBase.description ? (
                          <div className="truncate text-xs text-muted-foreground">
                            {knowledgeBase.description}
                          </div>
                        ) : null}
                      </div>
                      {connectorTypes.length > 0 && (
                        <OverlappedIcons
                          icons={connectorTypes.map((type) => ({
                            key: type,
                            icon: (
                              <ConnectorTypeIcon
                                type={type}
                                className="h-full w-full"
                              />
                            ),
                            tooltip: type,
                          }))}
                          maxVisible={3}
                          size="sm"
                          className="ml-2"
                        />
                      )}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
            {connectors.length > 0 && (
              <CommandGroup heading="Connectors">
                {connectors.map((connector) => {
                  const isSelected = selectedConnectorIds.includes(
                    connector.id,
                  );
                  return (
                    <CommandItem
                      key={connector.id}
                      value={connector.name}
                      className="data-[selected=true]:bg-transparent"
                      onSelect={() => {
                        onConnectorIdsChange?.(
                          isSelected
                            ? selectedConnectorIds.filter(
                                (id) => id !== connector.id,
                              )
                            : [...selectedConnectorIds, connector.id],
                        );
                      }}
                    >
                      <CheckIcon
                        className={cn(
                          "mr-2 h-4 w-4 shrink-0",
                          isSelected ? "opacity-100" : "opacity-0",
                        )}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm">{connector.name}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          {connector.description || (
                            <span className="capitalize">
                              {connector.connectorType}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="ml-2 shrink-0">
                        <ConnectorTypeIcon
                          type={connector.connectorType}
                          className="h-4 w-4"
                        />
                      </div>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

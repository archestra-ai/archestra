"use client";

import { useEffect, useState } from "react";
import { useInternalMcpCatalog } from "@/lib/internal-mcp-catalog.query";
import OnboardingStep from "../onboarding-step";
import OptionButton from "../option-button";

interface McpServerSelectionProps {
  isActive: boolean;
  isTransitioning: boolean;
  onSelect: (serverId: string, serverName?: string) => void;
  onNext: () => void;
}

export function McpServerSelection({
  isActive,
  isTransitioning,
  onSelect,
  onNext,
}: McpServerSelectionProps) {
  const { data: catalogItems } = useInternalMcpCatalog();
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const [selectedServerName, setSelectedServerName] = useState<string | null>(
    null,
  );

  useEffect(() => {
    if (selectedServerId) {
      onSelect(selectedServerId, selectedServerName || undefined);
    }
  }, [selectedServerId, selectedServerName, onSelect]);

  if (!catalogItems || catalogItems.length === 0) {
    return (
      <OnboardingStep
        title="MCP Server Registry"
        description="Select an MCP server to install from the registry"
        isActive={isActive}
        isTransitioning={isTransitioning}
      >
        <div className="text-sm text-slate-400">
          No MCP servers available in the catalog. Please add some to get
          started.
        </div>
      </OnboardingStep>
    );
  }

  return (
    <OnboardingStep
      title="MCP Server Registry"
      description="Select an MCP server to install from the registry"
      isActive={isActive}
      isTransitioning={isTransitioning}
      primaryAction={{
        label: "Continue",
        onClick: onNext,
        disabled: !selectedServerId,
      }}
    >
      <div className="space-y-2 max-h-96 overflow-y-auto">
        {catalogItems.map((item) => (
          <OptionButton
            key={item.id}
            active={selectedServerId === item.id}
            onClick={() => {
              setSelectedServerId(item.id);
              setSelectedServerName(item.name);
            }}
            className="justify-start h-auto p-3 w-full"
          >
            <div className="text-left w-full">
              <div className="font-semibold text-sm">{item.name}</div>
              {item.version && (
                <div className="text-xs text-slate-400">v{item.version}</div>
              )}
            </div>
          </OptionButton>
        ))}
      </div>
    </OnboardingStep>
  );
}

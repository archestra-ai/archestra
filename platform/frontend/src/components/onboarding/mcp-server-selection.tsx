"use client";

import type { ArchestraMcpServerManifest } from "@shared/hey-api/clients/archestra-catalog/types.gen";
import { useEffect, useState } from "react";
import { useMcpRegistryServersInfinite } from "@/lib/external-mcp-catalog.query";
import OnboardingStep from "../onboarding-step";
import OptionButton from "../option-button";

interface McpServerSelectionProps {
  isActive: boolean;
  isNextStep: boolean;
  isTransitioning: boolean;
  onSelect: (mcpServer: ArchestraMcpServerManifest) => void;
  onNext: () => void;
}

export function McpServerSelection({
  isActive,
  isNextStep,
  isTransitioning,
  onSelect,
  onNext,
}: McpServerSelectionProps) {
  const { data, isLoading } = useMcpRegistryServersInfinite(
    undefined,
    "all",
    3,
  );
  const [selectedServer, setSelectedServer] =
    useState<ArchestraMcpServerManifest | null>(null);

  // Get first 3 servers from the external catalog
  const catalogItems = data?.pages[0]?.servers?.slice(0, 3) || [];

  useEffect(() => {
    if (selectedServer) {
      onSelect(selectedServer || undefined);
    }
  }, [selectedServer, onSelect]);

  if (isLoading) {
    return (
      <OnboardingStep
        title="MCP Server Registry"
        description="Select an MCP server to install from the registry"
        isActive={isActive}
        isTransitioning={isTransitioning}
        isNextStep={isNextStep}
      >
        <div className="text-sm text-slate-400">Loading MCP servers...</div>
      </OnboardingStep>
    );
  }

  if (!catalogItems || catalogItems.length === 0) {
    return (
      <OnboardingStep
        title="MCP Server Registry"
        description="Select an MCP server to install from the registry"
        isActive={isActive}
        isTransitioning={isTransitioning}
        isNextStep={isNextStep}
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
        disabled: !selectedServer,
      }}
      isNextStep={isNextStep}
    >
      <div className="space-y-2 max-h-96 overflow-y-auto whitespace-normal break-words overflow-hidden">
        {catalogItems.map((item) => (
          <OptionButton
            key={item.name}
            active={
              (selectedServer?.server as any)?.url === (item.server as any).url
            }
            onClick={() => {
              setSelectedServer(item);
            }}
            className="justify-start h-auto p-3 w-full"
          >
            <div className="text-left w-full">
              <div className="font-semibold text-sm">{item.name}</div>
              {item.description && (
                <div className="text-xs text-slate-400">{item.description}</div>
              )}
            </div>
          </OptionButton>
        ))}
      </div>
    </OnboardingStep>
  );
}

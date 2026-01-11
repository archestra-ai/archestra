"use client";

import {
  ArchitectureDiagram,
  type ArchitectureTabType,
} from "@/components/architecture-diagram/architecture-diagram";

interface ArchestraArchitectureDiagramProps {
  activeTab?: ArchitectureTabType;
  onTabChange?: (tab: ArchitectureTabType) => void;
}

export function ArchestraArchitectureDiagram({
  activeTab,
  onTabChange,
}: ArchestraArchitectureDiagramProps = {}) {
  return (
    <div className="mb-8 max-w-3xl mx-auto h-[400px] flex items-center justify-center">
      <ArchitectureDiagram activeTab={activeTab} onTabChange={onTabChange} />
    </div>
  );
}

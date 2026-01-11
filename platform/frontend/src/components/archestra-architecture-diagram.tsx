"use client";

import { ArchitectureDiagram } from "@/components/architecture-diagram/architecture-diagram";

interface ArchestraArchitectureDiagramProps {
  activeTab?: "proxy" | "mcp";
  onTabChange?: (tab: "proxy" | "mcp") => void;
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

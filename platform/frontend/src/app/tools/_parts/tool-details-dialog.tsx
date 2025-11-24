"use client";

import { useState } from "react";
import { TruncatedText } from "@/components/truncated-text";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { ToolAssignmentsPanel } from "./tool-assignments-panel";
import { ToolPoliciesPanel } from "./tool-policies-panel";
import type { Tool } from "./types";

type TabId = "policies" | "assignments";

export function ToolDetailsDialog({
  tool,
  open,
  onOpenChange,
}: {
  tool: Tool | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [activeTab, setActiveTab] = useState<TabId>("policies");

  if (!tool) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] w-[95vw] max-w-[1200px] flex-col">
        <DialogHeader className="flex-shrink-0 space-y-2">
          <DialogTitle className="text-2xl font-semibold flex items-center gap-2">
            {tool.name}
            <Badge variant="outline">
              {tool.mcpServer
                ? `MCP Server: ${tool.mcpServer.name}`
                : "LLM Proxy"}
            </Badge>
          </DialogTitle>

          {tool.description && (
            <TruncatedText
              message={tool.description}
              maxLength={500}
              className="text-sm text-muted-foreground"
            />
          )}
        </DialogHeader>

        <div className="flex flex-1 flex-col gap-4 overflow-y-auto pr-2">
          <div className="flex gap-4 border-b pb-2 text-sm font-medium">
            {[
              { id: "policies", label: "Policies" },
              { id: "assignments", label: "Assignments" },
            ].map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id as TabId)}
                className={cn(
                  "relative pb-2 transition-colors",
                  activeTab === tab.id
                    ? "text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {tab.label}
                {activeTab === tab.id && (
                  <span className="absolute inset-x-0 bottom-0 h-0.5 bg-primary" />
                )}
              </button>
            ))}
          </div>

          {activeTab === "policies" && <ToolPoliciesPanel tool={tool} />}
          {activeTab === "assignments" && <ToolAssignmentsPanel tool={tool} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}

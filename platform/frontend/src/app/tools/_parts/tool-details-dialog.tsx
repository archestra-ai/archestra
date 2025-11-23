"use client";

import { useState } from "react";
import { TruncatedText } from "@/components/truncated-text";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn, formatDate } from "@/lib/utils";
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
          <DialogTitle className="text-2xl font-semibold">
            {tool.name}
          </DialogTitle>
          {tool.description && (
            <TruncatedText
              message={tool.description}
              maxLength={500}
              className="text-sm text-muted-foreground"
            />
          )}
          <div className="grid gap-3 md:grid-cols-4">
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">Origin</div>
              <div className="mt-1 text-sm font-medium">
                {tool.mcpServer ? "MCP Catalog" : "LLM Proxy"}
              </div>
              {tool.mcpServer?.name && (
                <div className="text-xs text-muted-foreground">
                  {tool.mcpServer.name}
                </div>
              )}
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">Profiles</div>
              <div className="mt-1 text-xl font-semibold">
                {tool.assignedAgentsCount}
              </div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">Policies</div>
              <div className="mt-1 text-xl font-semibold">
                {tool.policyCount}
              </div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">Updated</div>
              <div className="mt-1 text-sm text-muted-foreground">
                {formatDate({ date: tool.updatedAt })}
              </div>
            </div>
          </div>
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

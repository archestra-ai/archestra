"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { GetToolsResponses } from "@/lib/clients/api";
import { ToolCallPolicies } from "./tool-call-policies";
import { ToolReadonlyDetails } from "./tool-readonly-details";
import { ToolResultPolicies } from "./tool-result-policies";

interface ToolDetailsDialogProps {
  tool: GetToolsResponses["200"][number] | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ToolDetailsDialog({
  tool,
  open,
  onOpenChange,
}: ToolDetailsDialogProps) {
  if (!tool) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-6xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-xl font-semibold tracking-tight">
            {tool.name}
          </DialogTitle>
          {tool.description && (
            <p className="text-sm text-muted-foreground">{tool.description}</p>
          )}
        </DialogHeader>

        <div className="space-y-6">
          <ToolReadonlyDetails tool={tool} />
          <div className="space-y-6">
            <ToolCallPolicies tool={tool} />
            <ToolResultPolicies tool={tool} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

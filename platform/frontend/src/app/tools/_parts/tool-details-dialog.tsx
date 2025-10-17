"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { GetToolsResponses } from "@/lib/clients/api";
import { formatDate } from "@/lib/utils";
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
      <DialogContent className="w-[90vw] max-w-[1600px] max-h-[85vh] flex flex-col">
        <DialogHeader className="flex-shrink-0">
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <DialogTitle className="text-xl font-semibold tracking-tight">
                {tool.name}
              </DialogTitle>
              {tool.description && (
                <p className="text-sm text-muted-foreground mt-1">
                  {tool.description}
                </p>
              )}
            </div>
            <div className="flex gap-6 text-sm ml-6">
              <div>
                <div className="text-xs font-medium text-muted-foreground">
                  Agent
                </div>
                <div className="text-sm text-foreground mt-0.5">
                  {tool.agent?.name || "-"}
                </div>
              </div>
              <div>
                <div className="text-xs font-medium text-muted-foreground">
                  Detected
                </div>
                <div className="text-sm text-foreground mt-0.5">
                  {formatDate({ date: tool.createdAt })}
                </div>
              </div>
              <div>
                <div className="text-xs font-medium text-muted-foreground">
                  Updated
                </div>
                <div className="text-sm text-foreground mt-0.5">
                  {formatDate({ date: tool.updatedAt })}
                </div>
              </div>
            </div>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto pr-2 -mr-2">
          <div className="space-y-6">
            <ToolReadonlyDetails tool={tool} />
            <div className="grid grid-cols-2 gap-6">
              <ToolCallPolicies tool={tool} />
              <ToolResultPolicies tool={tool} />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

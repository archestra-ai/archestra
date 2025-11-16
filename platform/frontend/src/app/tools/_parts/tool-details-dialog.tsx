"use client";

import type { archestraApiTypes } from "@shared";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useInternalMcpCatalog } from "@/lib/internal-mcp-catalog.query";
import { isMcpTool } from "@/lib/tool.utils";
import { formatDate } from "@/lib/utils";
import { ResponseModifierEditor } from "./response-modifier-editor";
import { ToolCallPolicies } from "./tool-call-policies";
import { ToolReadonlyDetails } from "./tool-readonly-details";
import { ToolResultPolicies } from "./tool-result-policies";

interface ToolDetailsDialogProps {
  agentTool:
    | archestraApiTypes.GetAllAgentToolsResponses["200"]["data"][number]
    | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ToolDetailsDialog({
  agentTool,
  open,
  onOpenChange,
}: ToolDetailsDialogProps) {
  const { data: internalMcpCatalogItems } = useInternalMcpCatalog();
  if (!agentTool) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[90vw] max-w-[1600px] max-h-[85vh] flex flex-col">
        <DialogHeader className="flex-shrink-0">
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <DialogTitle className="text-xl font-semibold tracking-tight">
                {agentTool.tool.name}
              </DialogTitle>
              {agentTool.tool.description && (
                <p className="text-sm text-muted-foreground mt-1">
                  {agentTool.tool.description}
                </p>
              )}
            </div>
            <div className="flex gap-6 text-sm ml-6">
              <div>
                <div className="text-xs font-medium text-muted-foreground">
                  Agent
                </div>
                <div className="text-sm text-foreground mt-0.5">
                  {agentTool.agent.name || "-"}
                </div>
              </div>
              <div>
                <div className="text-xs font-medium text-muted-foreground">
                  Origin
                </div>
                <div className="mt-0.5">
                  {isMcpTool(agentTool.tool) ? (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Badge variant="default" className="bg-indigo-500">
                            MCP Server
                          </Badge>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>
                            {
                              internalMcpCatalogItems?.find(
                                (item) => item.id === agentTool.tool.catalogId,
                              )?.name
                            }
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  ) : (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Badge variant="secondary" className="bg-orange-800">
                            Intercepted
                          </Badge>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>Tool discovered via agent-LLM communication</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                </div>
              </div>
              <div>
                <div className="text-xs font-medium text-muted-foreground">
                  Detected
                </div>
                <div className="text-sm text-foreground mt-0.5">
                  {formatDate({ date: agentTool.createdAt })}
                </div>
              </div>
              <div>
                <div className="text-xs font-medium text-muted-foreground">
                  Updated
                </div>
                <div className="text-sm text-foreground mt-0.5">
                  {formatDate({ date: agentTool.updatedAt })}
                </div>
              </div>
            </div>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto pr-2 -mr-2">
          <div className="space-y-6">
            <ToolReadonlyDetails agentTool={agentTool} />
            <div className="grid grid-cols-2 gap-6">
              <ToolCallPolicies agentTool={agentTool} />
              <ToolResultPolicies agentTool={agentTool} />
            </div>
            <ResponseModifierEditor agentTool={agentTool} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

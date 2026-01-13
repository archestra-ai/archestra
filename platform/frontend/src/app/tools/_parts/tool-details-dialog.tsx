"use client";

import { ARCHESTRA_MCP_CATALOG_ID } from "@shared";
import { ChevronDown, ChevronRight, Layers, User } from "lucide-react";
import { useState } from "react";
import { TruncatedText } from "@/components/truncated-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
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
import { useInternalMcpCatalogSuspense } from "@/lib/internal-mcp-catalog.query";
import type { ToolWithAssignmentsData } from "@/lib/tool.query";
import { isMcpToolByProperties } from "@/lib/tool.utils";
import { formatDate } from "@/lib/utils";
import { ToolCallPolicies } from "./tool-call-policies";
import { ToolReadonlyDetails } from "./tool-readonly-details";
import { ToolResultPolicies } from "./tool-result-policies";

interface ToolDetailsDialogProps {
  tool: ToolWithAssignmentsData | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ToolDetailsDialog({
  tool,
  open,
  onOpenChange,
}: ToolDetailsDialogProps) {
  const { data: internalMcpCatalogItems } = useInternalMcpCatalogSuspense();
  const [assignmentsOpen, setAssignmentsOpen] = useState(true);

  if (!tool) return null;

  const catalogItem = internalMcpCatalogItems?.find(
    (item) => item.id === tool.catalogId,
  );

  // Check if this is a built-in Archestra tool (no credentials required)
  const isBuiltinArchestraTool = tool.catalogId === ARCHESTRA_MCP_CATALOG_ID;

  // Helper to get credential display text
  // Backend returns null for emails when user doesn't have access to the credential's MCP server
  const getCredentialDisplay = (assignment: (typeof tool.assignments)[0]) => {
    if (assignment.useDynamicTeamCredential) {
      return "Resolve at call time";
    }

    // Get the credential server ID (remote or local)
    const credentialServerId =
      assignment.credentialSourceMcpServerId ||
      assignment.executionSourceMcpServerId;

    // If no credential server, check if it's a built-in tool
    if (!credentialServerId) {
      return isBuiltinArchestraTool ? "Not required" : "—";
    }

    // Backend returns email if user has access, null if not
    const email =
      assignment.credentialOwnerEmail || assignment.executionOwnerEmail;

    if (!email) {
      // Credential server exists but user doesn't have access
      return "Owner outside your team";
    }

    return email;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[90vw] max-w-[1600px] max-h-[85vh] flex flex-col">
        <DialogHeader className="shrink-0">
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <DialogTitle className="text-xl font-semibold tracking-tight">
                {tool.name}
              </DialogTitle>
              {tool.description && (
                <TruncatedText
                  message={tool.description}
                  maxLength={200}
                  className="text-sm text-muted-foreground mt-1"
                />
              )}
            </div>
            <div className="flex gap-6 text-sm ml-6">
              <div>
                <div className="text-xs font-medium text-muted-foreground">
                  Origin
                </div>
                <div className="mt-0.5">
                  {isMcpToolByProperties(tool) ? (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Badge variant="default" className="bg-indigo-500">
                            MCP Server
                          </Badge>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>{catalogItem?.name || "MCP Server"}</p>
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

            {/* Profile Assignments Section */}
            <Collapsible
              open={assignmentsOpen}
              onOpenChange={setAssignmentsOpen}
            >
              <div className="border border-border rounded-lg bg-card">
                <CollapsibleTrigger asChild>
                  <Button
                    variant="ghost"
                    className="w-full flex items-center justify-between p-4 hover:bg-muted/50 rounded-t-lg"
                  >
                    <div className="flex items-center gap-2">
                      <User className="h-4 w-4" />
                      <span className="font-semibold text-sm">
                        Profile Assignments
                      </span>
                      <Badge variant="secondary" className="ml-2">
                        {tool.assignmentCount}
                      </Badge>
                    </div>
                    {assignmentsOpen ? (
                      <ChevronDown className="h-4 w-4" />
                    ) : (
                      <ChevronRight className="h-4 w-4" />
                    )}
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="border-t border-border">
                    {tool.assignments.length === 0 ? (
                      <div className="p-4 text-sm text-muted-foreground text-center">
                        No profile assignments
                      </div>
                    ) : (
                      <div className="divide-y divide-border">
                        {tool.assignments.map((assignment) => (
                          <div
                            key={assignment.agentToolId}
                            className="p-4 space-y-3"
                          >
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-3">
                                <Badge variant="secondary" className="gap-1">
                                  <Layers className="h-3 w-3" />
                                  {assignment.agent.name}
                                </Badge>
                                <span className="text-muted-foreground">→</span>
                                <span className="text-sm text-muted-foreground">
                                  {getCredentialDisplay(assignment)}
                                </span>
                              </div>
                            </div>
                            {assignment.responseModifierTemplate && (
                              <div className="text-xs text-muted-foreground">
                                <span className="font-medium">
                                  Response Modifier:{" "}
                                </span>
                                <code className="bg-muted px-1 py-0.5 rounded">
                                  {assignment.responseModifierTemplate.slice(
                                    0,
                                    50,
                                  )}
                                  {assignment.responseModifierTemplate.length >
                                  50
                                    ? "..."
                                    : ""}
                                </code>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </CollapsibleContent>
              </div>
            </Collapsible>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
              <ToolCallPolicies tool={tool} />
              <ToolResultPolicies tool={tool} />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

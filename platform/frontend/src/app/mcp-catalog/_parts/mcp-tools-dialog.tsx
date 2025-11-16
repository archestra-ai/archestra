"use client";

import { MCP_SERVER_TOOL_NAME_SEPARATOR } from "@shared";
import { UserPlus, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface McpToolsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverName: string;
  tools: Array<{
    id: string;
    name: string;
    description: string | null;
    assignedAgentCount: number;
    assignedAgents: Array<{ id: string; name: string }>;
    parameters: Record<string, unknown>;
    createdAt: string;
  }>;
  isLoading: boolean;
  onAssignTool: (tool: {
    id: string;
    name: string;
    description: string | null;
    parameters: Record<string, unknown>;
    createdAt: string;
  }) => void;
  onBulkAssignTools: (
    tools: Array<{
      id: string;
      name: string;
      description: string | null;
      parameters: Record<string, unknown>;
      createdAt: string;
    }>,
  ) => void;
}

export function McpToolsDialog({
  open,
  onOpenChange,
  serverName,
  tools,
  isLoading,
  onAssignTool,
  onBulkAssignTools,
}: McpToolsDialogProps) {
  const [selectedToolIds, setSelectedToolIds] = useState<string[]>([]);

  const formatToolName = (toolName: string) => {
    // Remove the MCP server name prefix from the tool name
    // For example:
    // - "github_mcp_server__update_pull_request_branch" -> "update_pull_request_branch"
    // - "huggingface__remote-mcp__hf_doc_fetch" -> "hf_doc_fetch"

    // Find the last occurrence of "__" and take everything after it
    const lastDoubleUnderscore = toolName.lastIndexOf(
      MCP_SERVER_TOOL_NAME_SEPARATOR,
    );

    if (lastDoubleUnderscore !== -1) {
      return toolName.substring(lastDoubleUnderscore + 2);
    }

    // Fallback: if no "__" found, return the original name
    return toolName;
  };

  const allSelected = useMemo(() => {
    return tools.length > 0 && selectedToolIds.length === tools.length;
  }, [tools, selectedToolIds]);

  const someSelected = useMemo(() => {
    return selectedToolIds.length > 0 && selectedToolIds.length < tools.length;
  }, [tools, selectedToolIds]);

  const toggleAll = () => {
    if (allSelected) {
      setSelectedToolIds([]);
    } else {
      setSelectedToolIds(tools.map((tool) => tool.id));
    }
  };

  const toggleTool = (toolId: string) => {
    setSelectedToolIds((prev) =>
      prev.includes(toolId)
        ? prev.filter((id) => id !== toolId)
        : [...prev, toolId],
    );
  };

  const handleBulkAssign = () => {
    const selectedTools = tools.filter((tool) =>
      selectedToolIds.includes(tool.id),
    );
    onBulkAssignTools(selectedTools);
    // Don't clear selection here - it will be cleared when the bulk assign dialog closes
  };

  const handleDialogChange = (newOpen: boolean) => {
    onOpenChange(newOpen);
    if (!newOpen) {
      setSelectedToolIds([]);
    }
  };

  const hasSelection = selectedToolIds.length > 0;

  return (
    <Dialog open={open} onOpenChange={handleDialogChange}>
      <DialogContent className="max-w-4xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Tools - {serverName}</DialogTitle>
          <DialogDescription>
            View and manage tools provided by this MCP server
          </DialogDescription>
        </DialogHeader>

        {!isLoading && tools.length > 0 && (
          <div className="flex items-center justify-between p-4 bg-muted/50 border border-border rounded-lg">
            <div className="flex items-center gap-3">
              {hasSelection ? (
                <>
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10">
                    <span className="text-sm font-semibold text-primary">
                      {selectedToolIds.length}
                    </span>
                  </div>
                  <span className="text-sm font-medium">
                    {selectedToolIds.length === 1
                      ? "tool selected"
                      : "tools selected"}
                  </span>
                </>
              ) : (
                <span className="text-sm text-muted-foreground">
                  Select tools to bulk assign to agents
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={handleBulkAssign}
                disabled={!hasSelection}
                className="gap-2"
              >
                <Users className="h-4 w-4" />
                Bulk Assign to Agents
              </Button>
              {hasSelection && (
                <>
                  <div className="h-4 w-px bg-border" />
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setSelectedToolIds([])}
                  >
                    Clear selection
                  </Button>
                </>
              )}
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="text-center py-8 text-muted-foreground">
              Loading tools...
            </div>
          ) : tools.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No tools found for this server
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">
                    <Checkbox
                      checked={allSelected}
                      onCheckedChange={toggleAll}
                      aria-label="Select all tools"
                      className={
                        someSelected ? "data-[state=checked]:bg-primary/50" : ""
                      }
                    />
                  </TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="text-center">Assigned Agents</TableHead>
                  <TableHead className="text-center">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tools.map((tool) => (
                  <TableRow key={tool.id}>
                    <TableCell>
                      <Checkbox
                        checked={selectedToolIds.includes(tool.id)}
                        onCheckedChange={() => toggleTool(tool.id)}
                        aria-label={`Select ${tool.name}`}
                      />
                    </TableCell>
                    <TableCell className="font-medium">
                      {formatToolName(tool.name)}
                    </TableCell>
                    <TableCell className="max-w-md">
                      <span className="text-sm text-muted-foreground line-clamp-2">
                        {tool.description || "No description"}
                      </span>
                    </TableCell>
                    <TableCell className="text-center">
                      {tool.assignedAgents.length === 0 ? (
                        <span className="text-sm text-muted-foreground">
                          None
                        </span>
                      ) : (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="text-sm text-muted-foreground cursor-help truncate max-w-[150px] inline-block">
                                {tool.assignedAgents
                                  .map((a) => a.name)
                                  .join(", ")}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>
                              <div className="space-y-1">
                                {tool.assignedAgents.map((agent) => (
                                  <div key={agent.id}>{agent.name}</div>
                                ))}
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      )}
                    </TableCell>
                    <TableCell className="text-center">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onAssignTool(tool)}
                        title="Assign Tool to Agents"
                      >
                        <UserPlus className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

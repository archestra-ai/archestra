"use client";

import { E2eTestId, parseFullToolName } from "@shared";
import { Search, UserPlus, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
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
  const [searchQuery, setSearchQuery] = useState("");

  const filteredTools = useMemo(() => {
    if (!searchQuery.trim()) return tools;

    const query = searchQuery.toLowerCase();
    return tools.filter((tool) =>
      (parseFullToolName(tool.name).toolName || tool.name)
        .toLowerCase()
        .includes(query),
    );
  }, [tools, searchQuery]);

  const allSelected = useMemo(() => {
    return (
      filteredTools.length > 0 &&
      selectedToolIds.length === filteredTools.length
    );
  }, [filteredTools, selectedToolIds]);

  const someSelected = useMemo(() => {
    return (
      selectedToolIds.length > 0 &&
      selectedToolIds.length < filteredTools.length
    );
  }, [filteredTools, selectedToolIds]);

  const toggleAll = () => {
    if (allSelected) {
      setSelectedToolIds([]);
    } else {
      setSelectedToolIds(filteredTools.map((tool) => tool.id));
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
    // Clear selections immediately after bulk assignment
    setSelectedToolIds([]);
  };

  const handleDialogChange = (newOpen: boolean) => {
    onOpenChange(newOpen);
    if (!newOpen) {
      setSelectedToolIds([]);
      setSearchQuery("");
    }
  };

  const hasSelection = selectedToolIds.length > 0;

  return (
    <StandardDialog
      open={open}
      onOpenChange={handleDialogChange}
      title={`Tools - ${serverName}`}
      description="View and manage tools provided by this MCP server"
      size="large"
      className="max-h-[80vh]"
      bodyClassName="space-y-4"
    >
      {!isLoading && tools.length > 0 && (
        <div className="relative">
          <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search tools by name..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>
      )}

      {!isLoading && tools.length > 0 && (
        <div className="flex items-center justify-between rounded-lg border border-border bg-muted/50 p-4">
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
                Select tools to bulk assign to profiles
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
              Bulk Assign to Profiles
            </Button>
            {hasSelection ? (
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
            ) : null}
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="py-8 text-center text-muted-foreground">
          Loading tools...
        </div>
      ) : tools.length === 0 ? (
        <div className="py-8 text-center text-muted-foreground">
          No tools found for this server
        </div>
      ) : filteredTools.length === 0 ? (
        <div className="flex flex-col items-center justify-center space-y-4 py-8">
          <div className="text-center text-muted-foreground">
            No tools match your search
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSearchQuery("")}
          >
            Clear search
          </Button>
        </div>
      ) : (
        <div
          className="overflow-hidden rounded-md border"
          data-testid={E2eTestId.McpToolsDialog}
        >
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
                <TableHead className="text-center">Assigned Profiles</TableHead>
                <TableHead className="text-center">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredTools.map((tool) => (
                <TableRow key={tool.id}>
                  <TableCell>
                    <Checkbox
                      checked={selectedToolIds.includes(tool.id)}
                      onCheckedChange={() => toggleTool(tool.id)}
                      aria-label={`Select ${tool.name}`}
                    />
                  </TableCell>
                  <TableCell className="font-medium">
                    {parseFullToolName(tool.name).toolName || tool.name}
                  </TableCell>
                  <TableCell className="max-w-md">
                    <span className="line-clamp-2 text-sm text-muted-foreground">
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
                            <span className="inline-block max-w-[150px] cursor-help truncate text-sm text-muted-foreground">
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
                      title="Assign Tool to Profiles"
                    >
                      <UserPlus className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </StandardDialog>
  );
}

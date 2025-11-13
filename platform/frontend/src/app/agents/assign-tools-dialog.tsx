"use client";

import type { archestraApiTypes } from "@shared";
import { Loader2, Search, Server } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { InstallationSelect } from "@/components/installation-select";
import { TokenSelect } from "@/components/token-select";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  useAgentToolPatchMutation,
  useAllAgentTools,
  useAssignTool,
  useUnassignTool,
} from "@/lib/agent-tools.query";
import { useInternalMcpCatalog } from "@/lib/internal-mcp-catalog.query";
import { useTools } from "@/lib/tool.query";

interface AssignToolsDialogProps {
  agent: archestraApiTypes.GetAllAgentsResponses["200"][number];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AssignToolsDialog({
  agent,
  open,
  onOpenChange,
}: AssignToolsDialogProps) {
  // Fetch all tools and filter for MCP tools
  const { data: allTools, isLoading: isLoadingAllTools } = useTools({});
  const mcpTools = allTools?.filter((tool) => tool.catalogId !== null) || [];
  const { data: internalMcpCatalogItems } = useInternalMcpCatalog();

  // Fetch currently assigned tools for this agent (use getAllAgentTools to get credentialSourceMcpServerId)
  const { data: allAgentTools } = useAllAgentTools({});
  const agentToolRelations = useMemo(
    () => allAgentTools?.data?.filter((at) => at.agent.id === agent.id) || [],
    [allAgentTools, agent.id],
  );

  // Track selected tools with their credentials, execution source, and agent-tool IDs
  const [selectedTools, setSelectedTools] = useState<
    {
      toolId: string;
      credentialsSourceId?: string;
      executionSourceId?: string;
      agentToolId?: string;
    }[]
  >([]);

  // Track search query
  const [searchQuery, setSearchQuery] = useState("");

  // Filter tools based on search query
  const filteredTools = useMemo(() => {
    if (!searchQuery.trim()) return mcpTools;

    const query = searchQuery.toLowerCase();
    return mcpTools.filter((tool) => tool.name.toLowerCase().includes(query));
  }, [mcpTools, searchQuery]);

  // Initialize selected tools when agent tools load
  useEffect(() => {
    if (agentToolRelations) {
      setSelectedTools(
        agentToolRelations.map((at) => ({
          toolId: at.tool.id,
          credentialsSourceId: at.credentialSourceMcpServerId || undefined,
          executionSourceId: at.executionSourceMcpServerId || undefined,
          agentToolId: at.id,
        })),
      );
    }
  }, [agentToolRelations]);

  const assignTool = useAssignTool();
  const unassignTool = useUnassignTool();
  const patchAgentTool = useAgentToolPatchMutation();

  const isLoading = isLoadingAllTools;
  const isSaving =
    assignTool.isPending || unassignTool.isPending || patchAgentTool.isPending;

  const handleToggleTool = useCallback((toolId: string) => {
    setSelectedTools((prev) => {
      const isSelected = prev.some((t) => t.toolId === toolId);
      if (isSelected) {
        // Remove the tool
        return prev.filter((t) => t.toolId !== toolId);
      }
      // Add the tool
      return [...prev, { toolId, credentialsSourceId: undefined }];
    });
  }, []);

  const handleCredentialsSourceChange = useCallback(
    (toolId: string, credentialsSourceId?: string) => {
      setSelectedTools((prev) => {
        return prev.map((tool) =>
          tool.toolId === toolId ? { ...tool, credentialsSourceId } : tool,
        );
      });
    },
    [],
  );

  const handleExecutionSourceChange = useCallback(
    (toolId: string, executionSourceId?: string) => {
      setSelectedTools((prev) => {
        return prev.map((tool) =>
          tool.toolId === toolId ? { ...tool, executionSourceId } : tool,
        );
      });
    },
    [],
  );

  const handleSave = useCallback(async () => {
    // Get current tool IDs and their state
    const currentToolIds = new Set(agentToolRelations.map((at) => at.tool.id));
    const selectedToolIds = new Set(selectedTools.map((t) => t.toolId));

    // Determine which tools to assign, unassign, and update
    const toAssign = selectedTools.filter(
      (tool) => !currentToolIds.has(tool.toolId),
    );
    const toUnassign = agentToolRelations.filter(
      (at) => !selectedToolIds.has(at.tool.id),
    );
    const toUpdate = selectedTools.filter((tool) => {
      if (!tool.agentToolId) return false;
      const current = agentToolRelations.find(
        (at) => at.tool.id === tool.toolId,
      );
      return (
        current &&
        (current.credentialSourceMcpServerId !==
          (tool.credentialsSourceId || null) ||
          current.executionSourceMcpServerId !==
            (tool.executionSourceId || null))
      );
    });

    try {
      // Assign new tools
      for (const tool of toAssign) {
        await assignTool.mutateAsync({
          agentId: agent.id,
          toolId: tool.toolId,
          credentialSourceMcpServerId: tool.credentialsSourceId || null,
          executionSourceMcpServerId: tool.executionSourceId || null,
        });
      }

      // Unassign removed tools
      for (const at of toUnassign) {
        await unassignTool.mutateAsync({
          agentId: agent.id,
          toolId: at.tool.id,
        });
      }

      // Update credentials and execution source for existing tools
      for (const tool of toUpdate) {
        if (tool.agentToolId) {
          await patchAgentTool.mutateAsync({
            id: tool.agentToolId,
            credentialSourceMcpServerId: tool.credentialsSourceId || null,
            executionSourceMcpServerId: tool.executionSourceId || null,
          });
        }
      }

      toast.success(`Successfully updated tools for ${agent.name}`);

      onOpenChange(false);
    } catch (_error) {
      toast.error("Failed to update tool assignments");
    }
  }, [
    agent,
    agentToolRelations,
    assignTool,
    unassignTool,
    patchAgentTool,
    onOpenChange,
    selectedTools,
  ]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Assign Tools to {agent.name}</DialogTitle>
          <DialogDescription>
            Select which MCP server tools this agent can access.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search tools by name..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>

        <div className="flex-1 overflow-y-auto pr-2 -mr-2">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : mcpTools.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <Server className="h-12 w-12 text-muted-foreground mb-2" />
              <p className="text-sm text-muted-foreground">
                No MCP server tools available.
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Install an MCP server to get started.
              </p>
            </div>
          ) : filteredTools.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <Search className="mb-4 h-12 w-12 text-muted-foreground/50" />
              <h3 className="mb-2 text-lg font-semibold">No tools found</h3>
              <p className="mb-4 text-sm text-muted-foreground">
                No tools match "{searchQuery}". Try adjusting your search.
              </p>
              <Button variant="outline" onClick={() => setSearchQuery("")}>
                Clear search
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              {filteredTools.map((tool) => (
                <div
                  key={tool.id}
                  className="flex items-start space-x-3 rounded-lg border p-4 hover:bg-muted/50 transition-colors"
                >
                  <Checkbox
                    id={`tool-${tool.id}`}
                    checked={selectedTools.some((t) => t.toolId === tool.id)}
                    onCheckedChange={() => handleToggleTool(tool.id)}
                    disabled={isSaving}
                  />
                  <div className="flex-1 space-y-1">
                    <Label
                      htmlFor={`tool-${tool.id}`}
                      className="text-sm font-medium leading-none cursor-pointer mb-2"
                    >
                      {tool.name}
                    </Label>
                    {selectedTools.some((t) => t.toolId === tool.id) &&
                      (() => {
                        const mcpCatalogItem = internalMcpCatalogItems?.find(
                          (item) => item.id === tool.catalogId,
                        );
                        const catalogId = tool.catalogId ?? "";
                        const isLocalServer =
                          mcpCatalogItem?.serverType === "local";
                        const selectedTool = selectedTools.find(
                          (t) => t.toolId === tool.id,
                        );

                        return (
                          <div className="flex flex-col gap-1 mt-4">
                            {isLocalServer ? (
                              <>
                                <span className="text-xs text-muted-foreground">
                                  Credential to use:
                                </span>
                                <InstallationSelect
                                  catalogId={catalogId}
                                  agentIds={[agent.id]}
                                  onValueChange={(executionSourceId) =>
                                    handleExecutionSourceChange(
                                      tool.id,
                                      executionSourceId ?? undefined,
                                    )
                                  }
                                  value={
                                    selectedTool?.executionSourceId ?? undefined
                                  }
                                  className="mb-4"
                                />
                              </>
                            ) : (
                              <>
                                <span className="text-xs text-muted-foreground">
                                  Credential to use:
                                </span>
                                <TokenSelect
                                  catalogId={catalogId}
                                  agentIds={[agent.id]}
                                  onValueChange={(credentialsSourceId) =>
                                    handleCredentialsSourceChange(
                                      tool.id,
                                      credentialsSourceId ?? undefined,
                                    )
                                  }
                                  value={
                                    selectedTool?.credentialsSourceId ??
                                    undefined
                                  }
                                  className="mb-4"
                                />
                              </>
                            )}
                          </div>
                        );
                      })()}
                    {tool.description && (
                      <p className="text-sm text-muted-foreground">
                        {tool.description}
                      </p>
                    )}
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Server className="h-3 w-3" />
                      <span>MCP Server Tool</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={
              isLoading ||
              isSaving ||
              selectedTools.some((tool) => {
                const mcpTool = mcpTools.find((t) => t.id === tool.toolId);
                const mcpCatalogItem = internalMcpCatalogItems?.find(
                  (item) => item.id === mcpTool?.catalogId,
                );
                const isLocalServer = mcpCatalogItem?.serverType === "local";
                return isLocalServer
                  ? !tool.executionSourceId
                  : !tool.credentialsSourceId;
              })
            }
          >
            {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

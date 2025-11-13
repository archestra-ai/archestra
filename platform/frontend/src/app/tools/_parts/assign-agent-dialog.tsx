"use client";

import type { archestraApiTypes } from "@shared";
import { Search } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
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
import { useAgents } from "@/lib/agent.query";
import { useAssignTool } from "@/lib/agent-tools.query";
import { useInternalMcpCatalog } from "@/lib/internal-mcp-catalog.query";

interface AssignAgentDialogProps {
  tool:
    | archestraApiTypes.GetAllAgentToolsResponses["200"]["data"][number]
    | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AssignAgentDialog({
  tool,
  open,
  onOpenChange,
}: AssignAgentDialogProps) {
  const { data: agents } = useAgents({});
  const assignMutation = useAssignTool();
  const { data: mcpCatalog } = useInternalMcpCatalog();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);
  const [credentialSourceMcpServerId, setCredentialSourceMcpServerId] =
    useState<string | null>(null);
  const [executionSourceMcpServerId, setExecutionSourceMcpServerId] = useState<
    string | null
  >(null);

  // Determine if tool is from local server
  const mcpCatalogItem = useMemo(() => {
    if (!tool?.tool.catalogId) return null;
    return mcpCatalog?.find((item) => item.id === tool.tool.catalogId);
  }, [tool?.tool.catalogId, mcpCatalog]);

  const catalogId = tool?.tool.catalogId ?? "";
  const isLocalServer = mcpCatalogItem?.serverType === "local";

  const filteredAgents = useMemo(() => {
    if (!agents || !searchQuery.trim()) return agents;

    const query = searchQuery.toLowerCase();
    return agents.filter((agent) => agent.name.toLowerCase().includes(query));
  }, [agents, searchQuery]);

  const handleAssign = useCallback(async () => {
    if (!tool || selectedAgentIds.length === 0) return;

    // Helper function to check if an error is a duplicate key error
    const isDuplicateError = (error: unknown): boolean => {
      if (!error) return false;
      const errorStr = JSON.stringify(error).toLowerCase();
      return (
        errorStr.includes("duplicate key") ||
        errorStr.includes("agent_tools_agent_id_tool_id_unique") ||
        errorStr.includes("already assigned")
      );
    };

    const results = await Promise.allSettled(
      selectedAgentIds.map((agentId) =>
        assignMutation.mutateAsync({
          agentId,
          toolId: tool.tool.id,
          credentialSourceMcpServerId: isLocalServer
            ? null
            : credentialSourceMcpServerId || null,
          executionSourceMcpServerId: isLocalServer
            ? executionSourceMcpServerId || null
            : null,
        }),
      ),
    );

    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected").length;
    const totalAttempted = results.length;

    // Check if failures are due to duplicates
    const duplicates = results.filter(
      (r) => r.status === "rejected" && isDuplicateError(r.reason),
    ).length;

    const actualFailures = failed - duplicates;

    if (succeeded > 0) {
      if (duplicates > 0 && actualFailures === 0) {
        toast.success(
          `Successfully assigned ${tool.tool.name} to ${succeeded} agent${succeeded !== 1 ? "s" : ""}. ${duplicates} ${duplicates === 1 ? "was" : "were"} already assigned.`,
        );
      } else if (actualFailures > 0) {
        toast.warning(
          `Assigned ${tool.tool.name} to ${succeeded} of ${totalAttempted} agent${totalAttempted !== 1 ? "s" : ""}. ${actualFailures} failed.`,
        );
      } else {
        toast.success(
          `Successfully assigned ${tool.tool.name} to ${succeeded} agent${succeeded !== 1 ? "s" : ""}`,
        );
      }
    } else if (duplicates === failed) {
      toast.info(
        `${tool.tool.name} is already assigned to all selected agents`,
      );
    } else {
      toast.error(`Failed to assign ${tool.tool.name}`);
      console.error("Assignment errors:", results);
    }

    setSelectedAgentIds([]);
    setSearchQuery("");
    setCredentialSourceMcpServerId(null);
    setExecutionSourceMcpServerId(null);
    onOpenChange(false);
  }, [
    tool,
    selectedAgentIds,
    credentialSourceMcpServerId,
    executionSourceMcpServerId,
    isLocalServer,
    assignMutation,
    onOpenChange,
  ]);

  const toggleAgent = useCallback((agentId: string) => {
    setSelectedAgentIds((prev) =>
      prev.includes(agentId)
        ? prev.filter((id) => id !== agentId)
        : [...prev, agentId],
    );
  }, []);

  return (
    <Dialog
      open={open}
      onOpenChange={(newOpen) => {
        onOpenChange(newOpen);
        if (!newOpen) {
          setSelectedAgentIds([]);
          setSearchQuery("");
          setCredentialSourceMcpServerId(null);
          setExecutionSourceMcpServerId(null);
        }
      }}
    >
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Assign Tool to Agents</DialogTitle>
          <DialogDescription>
            Select one or more agents to assign "{tool?.tool.name}" to.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-hidden flex flex-col">
          <div className="mb-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search agents..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto border rounded-md">
            {!filteredAgents || filteredAgents.length === 0 ? (
              <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                {searchQuery
                  ? "No agents match your search"
                  : "No agents available"}
              </div>
            ) : (
              <div className="divide-y">
                {filteredAgents.map((agent) => (
                  <div
                    key={agent.id}
                    className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-muted/50 w-full text-left"
                  >
                    <Checkbox
                      checked={selectedAgentIds.includes(agent.id)}
                      onCheckedChange={() => toggleAgent(agent.id)}
                    />
                    <span className="text-sm">{agent.name}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {selectedAgentIds.length > 0 && (
          <div className="pt-4 border-t">
            {isLocalServer ? (
              <>
                <Label
                  htmlFor="installation-select"
                  className="text-md font-medium mb-1"
                >
                  Credential to use *
                </Label>
                <p className="text-xs text-muted-foreground mb-2">
                  Select whose MCP server installation will execute the tool
                </p>
                <InstallationSelect
                  value={executionSourceMcpServerId}
                  onValueChange={setExecutionSourceMcpServerId}
                  className="w-full"
                  catalogId={catalogId}
                  agentIds={selectedAgentIds}
                />
              </>
            ) : (
              <>
                <Label
                  htmlFor="token-select"
                  className="text-md font-medium mb-1"
                >
                  Credential to use *
                </Label>
                <p className="text-xs text-muted-foreground mb-2">
                  Select which token will be used when these agents execute this
                  tool
                </p>
                <TokenSelect
                  value={credentialSourceMcpServerId}
                  onValueChange={setCredentialSourceMcpServerId}
                  className="w-full"
                  catalogId={catalogId}
                  agentIds={selectedAgentIds}
                />
              </>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              setSelectedAgentIds([]);
              setSearchQuery("");
              setCredentialSourceMcpServerId(null);
              setExecutionSourceMcpServerId(null);
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button
            onClick={handleAssign}
            disabled={
              selectedAgentIds.length === 0 ||
              assignMutation.isPending ||
              (selectedAgentIds.length > 0 &&
                isLocalServer &&
                !executionSourceMcpServerId) ||
              (selectedAgentIds.length > 0 &&
                !isLocalServer &&
                !credentialSourceMcpServerId)
            }
          >
            {assignMutation.isPending
              ? "Assigning..."
              : `Assign to ${selectedAgentIds.length} agent${selectedAgentIds.length !== 1 ? "s" : ""}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

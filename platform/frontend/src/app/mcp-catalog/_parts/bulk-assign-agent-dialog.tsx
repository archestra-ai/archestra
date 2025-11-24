"use client";

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
import { useBulkAssignTools } from "@/lib/agent-tools.query";
import { useMcpServers } from "@/lib/mcp-server.query";

interface BulkAssignAgentDialogProps {
  tools: Array<{
    id: string;
    name: string;
    description: string | null;
    parameters: Record<string, unknown>;
    createdAt: string;
  }> | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  catalogId: string;
}

export function BulkAssignAgentDialog({
  tools,
  open,
  onOpenChange,
  catalogId,
}: BulkAssignAgentDialogProps) {
  const { data: agents } = useAgents();
  const bulkAssignMutation = useBulkAssignTools();
  const mcpServers = useMcpServers();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);
  const [credentialSourceMcpServerId, setCredentialSourceMcpServerId] =
    useState<string | null>(null);
  const [executionSourceMcpServerId, setExecutionSourceMcpServerId] = useState<
    string | null
  >(null);

  // Determine if tools are from local server by checking catalogId
  const mcpServer = mcpServers.data?.find(
    (server) => server.catalogId === catalogId,
  );
  const isLocalServer = mcpServer?.serverType === "local";

  const filteredAgents = useMemo(() => {
    if (!agents || !searchQuery.trim()) return agents;

    const query = searchQuery.toLowerCase();
    return agents.filter((agent) => agent.name.toLowerCase().includes(query));
  }, [agents, searchQuery]);

  const handleAssign = useCallback(async () => {
    if (!tools || tools.length === 0 || selectedAgentIds.length === 0) return;

    // Assign each tool to each selected agent
    const assignments = tools.flatMap((tool) =>
      selectedAgentIds.map((agentId) => ({
        agentId,
        toolId: tool.id,
        credentialSourceMcpServerId: isLocalServer
          ? null
          : credentialSourceMcpServerId,
        executionSourceMcpServerId: isLocalServer
          ? executionSourceMcpServerId
          : null,
      })),
    );

    try {
      const result = await bulkAssignMutation.mutateAsync({
        assignments,
        mcpServerId: mcpServer?.id,
      });

      if (!result) {
        toast.error("Failed to assign tools");
        return;
      }

      const { succeeded, failed, duplicates } = result;

      if (succeeded.length > 0) {
        if (duplicates.length > 0 && failed.length === 0) {
          toast.success(
            `Successfully assigned ${succeeded.length} tool assignment${succeeded.length !== 1 ? "s" : ""}. ${duplicates.length} ${duplicates.length === 1 ? "was" : "were"} already assigned.`,
          );
        } else if (failed.length > 0) {
          toast.warning(
            `Assigned ${succeeded.length} of ${assignments.length} tool${assignments.length !== 1 ? "s" : ""}. ${failed.length} failed.`,
          );
        } else {
          toast.success(
            `Successfully assigned ${succeeded.length} tool assignment${succeeded.length !== 1 ? "s" : ""}`,
          );
        }
      } else if (duplicates.length === assignments.length) {
        toast.info(
          "All selected tools are already assigned to the selected profiles",
        );
      } else {
        toast.error("Failed to assign tools");
        console.error("Bulk assignment errors:", failed);
      }

      setSelectedAgentIds([]);
      setSearchQuery("");
      setCredentialSourceMcpServerId(null);
      setExecutionSourceMcpServerId(null);
      onOpenChange(false);
    } catch (error) {
      toast.error("Failed to assign tools");
      console.error("Bulk assignment error:", error);
    }
  }, [
    tools,
    selectedAgentIds,
    credentialSourceMcpServerId,
    executionSourceMcpServerId,
    isLocalServer,
    bulkAssignMutation,
    onOpenChange,
    mcpServer?.id,
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
          <DialogTitle>Bulk Assign Tools to Profiles</DialogTitle>
          <DialogDescription>
            Select one or more profiles to assign {tools?.length || 0} tool
            {tools && tools.length !== 1 ? "s" : ""} to.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-hidden flex flex-col">
          <div className="mb-4 space-y-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search profiles..."
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
                  ? "No profiles match your search"
                  : "No profiles available"}
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

          <div className="mt-10">
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
                  shouldSetDefaultValue
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
                  Select which token will be used when profiles execute these
                  tools
                </p>
                <TokenSelect
                  value={credentialSourceMcpServerId}
                  onValueChange={setCredentialSourceMcpServerId}
                  className="w-full"
                  catalogId={catalogId}
                  shouldSetDefaultValue
                />
              </>
            )}
          </div>
        </div>

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
              bulkAssignMutation.isPending ||
              (isLocalServer && !executionSourceMcpServerId) ||
              (!isLocalServer && !credentialSourceMcpServerId)
            }
          >
            {bulkAssignMutation.isPending
              ? "Assigning..."
              : `Assign to ${selectedAgentIds.length} profile${selectedAgentIds.length !== 1 ? "s" : ""}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

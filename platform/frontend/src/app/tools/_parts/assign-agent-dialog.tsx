"use client";

import type { archestraApiTypes } from "@shared";
import { Search } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  DYNAMIC_CREDENTIAL_VALUE,
  TokenSelect,
} from "@/components/token-select";
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
import { useProfiles } from "@/lib/agent.query";
import { useAssignTool } from "@/lib/agent-tools.query";
import { useInternalMcpCatalogSuspense } from "@/lib/internal-mcp-catalog.query";

interface AssignProfileDialogProps {
  tool:
    | archestraApiTypes.GetAllAgentToolsResponses["200"]["data"][number]
    | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AssignProfileDialog({
  tool,
  open,
  onOpenChange,
}: AssignProfileDialogProps) {
  const { data: agents } = useProfiles();
  const assignMutation = useAssignTool();
  const { data: mcpCatalog } = useInternalMcpCatalogSuspense();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedProfileIds, setSelectedProfileIds] = useState<string[]>([]);
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

  const filteredProfiles = useMemo(() => {
    if (!agents || !searchQuery.trim()) return agents;

    const query = searchQuery.toLowerCase();
    return agents.filter((agent) => agent.name.toLowerCase().includes(query));
  }, [agents, searchQuery]);

  const handleAssign = useCallback(async () => {
    if (!tool || selectedProfileIds.length === 0) return;

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

    // Check if dynamic credential is selected (for both local and remote servers)
    const useDynamicCredential =
      credentialSourceMcpServerId === DYNAMIC_CREDENTIAL_VALUE ||
      executionSourceMcpServerId === DYNAMIC_CREDENTIAL_VALUE;

    const results = await Promise.allSettled(
      selectedProfileIds.map((agentId) =>
        assignMutation.mutateAsync({
          agentId,
          toolId: tool.tool.id,
          credentialSourceMcpServerId: isLocalServer
            ? null
            : useDynamicCredential
              ? null
              : credentialSourceMcpServerId || null,
          executionSourceMcpServerId: isLocalServer
            ? useDynamicCredential
              ? null
              : executionSourceMcpServerId || null
            : null,
          useDynamicTeamCredential: useDynamicCredential,
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

    setSelectedProfileIds([]);
    setSearchQuery("");
    setCredentialSourceMcpServerId(null);
    setExecutionSourceMcpServerId(null);
    onOpenChange(false);
  }, [
    tool,
    selectedProfileIds,
    credentialSourceMcpServerId,
    executionSourceMcpServerId,
    isLocalServer,
    assignMutation,
    onOpenChange,
  ]);

  const toggleProfile = useCallback((agentId: string) => {
    setSelectedProfileIds((prev) =>
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
          setSelectedProfileIds([]);
          setSearchQuery("");
          setCredentialSourceMcpServerId(null);
          setExecutionSourceMcpServerId(null);
        }
      }}
    >
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Assign Tool</DialogTitle>
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
            {!filteredProfiles || filteredProfiles.length === 0 ? (
              <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                {searchQuery
                  ? "No agents match your search"
                  : "No agents available"}
              </div>
            ) : (
              <div className="divide-y">
                {filteredProfiles.map((agent) => (
                  <div
                    key={agent.id}
                    className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-muted/50 w-full text-left"
                  >
                    <Checkbox
                      checked={selectedProfileIds.includes(agent.id)}
                      onCheckedChange={() => toggleProfile(agent.id)}
                    />
                    <span className="text-sm">{agent.name}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {selectedProfileIds.length > 0 && (
          <div className="pt-4 border-t">
            <Label htmlFor="token-select" className="text-md font-medium mb-1">
              Credential to use *
            </Label>
            <p className="text-xs text-muted-foreground mb-2">
              Select which credential will be used when these agents execute
              this tool
            </p>
            <TokenSelect
              value={
                isLocalServer
                  ? executionSourceMcpServerId
                  : credentialSourceMcpServerId
              }
              onValueChange={
                isLocalServer
                  ? setExecutionSourceMcpServerId
                  : setCredentialSourceMcpServerId
              }
              className="w-full"
              catalogId={catalogId}
              shouldSetDefaultValue
            />
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              setSelectedProfileIds([]);
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
              selectedProfileIds.length === 0 ||
              assignMutation.isPending ||
              (selectedProfileIds.length > 0 &&
                isLocalServer &&
                !executionSourceMcpServerId) ||
              (selectedProfileIds.length > 0 &&
                !isLocalServer &&
                !credentialSourceMcpServerId)
            }
          >
            {assignMutation.isPending
              ? "Assigning..."
              : `Assign to ${selectedProfileIds.length} profile${selectedProfileIds.length !== 1 ? "s" : ""}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

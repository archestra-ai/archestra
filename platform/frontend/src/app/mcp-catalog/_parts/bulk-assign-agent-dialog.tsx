"use client";

import { ARCHESTRA_MCP_CATALOG_ID } from "@shared";
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
import { useBulkAssignTools } from "@/lib/agent-tools.query";
import { useMcpServers } from "@/lib/mcp-server.query";

interface BulkAssignProfileDialogProps {
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

export function BulkAssignProfileDialog({
  tools,
  open,
  onOpenChange,
  catalogId,
}: BulkAssignProfileDialogProps) {
  const { data: agents } = useProfiles();
  const bulkAssignMutation = useBulkAssignTools();
  const mcpServers = useMcpServers();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedProfileIds, setSelectedProfileIds] = useState<string[]>([]);
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

  // Check if this is a built-in Archestra tool (no credentials required)
  const isBuiltinArchestraTool = catalogId === ARCHESTRA_MCP_CATALOG_ID;

  const filteredProfiles = useMemo(() => {
    if (!agents || !searchQuery.trim()) return agents;

    const query = searchQuery.toLowerCase();
    return agents.filter((agent) => agent.name.toLowerCase().includes(query));
  }, [agents, searchQuery]);

  const handleAssign = useCallback(async () => {
    if (!tools || tools.length === 0 || selectedProfileIds.length === 0) return;

    // Check if dynamic credential is selected
    const useDynamicCredential =
      credentialSourceMcpServerId === DYNAMIC_CREDENTIAL_VALUE ||
      executionSourceMcpServerId === DYNAMIC_CREDENTIAL_VALUE;

    // Assign each tool to each selected agent
    const assignments = tools.flatMap((tool) =>
      selectedProfileIds.map((agentId) => ({
        agentId,
        toolId: tool.id,
        credentialSourceMcpServerId: isLocalServer
          ? null
          : useDynamicCredential
            ? null
            : credentialSourceMcpServerId,
        executionSourceMcpServerId: isLocalServer
          ? useDynamicCredential
            ? null
            : executionSourceMcpServerId
          : null,
        useDynamicTeamCredential: useDynamicCredential,
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

      setSelectedProfileIds([]);
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
    selectedProfileIds,
    credentialSourceMcpServerId,
    executionSourceMcpServerId,
    isLocalServer,
    bulkAssignMutation,
    onOpenChange,
    mcpServer?.id,
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
            {!filteredProfiles || filteredProfiles.length === 0 ? (
              <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                {searchQuery
                  ? "No profiles match your search"
                  : "No profiles available"}
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

          {!isBuiltinArchestraTool && (
            <div className="mt-10">
              <Label
                htmlFor="token-select"
                className="text-md font-medium mb-1"
              >
                Credential to use *
              </Label>
              <p className="text-xs text-muted-foreground mb-2">
                Select which credential will be used when profiles execute these
                tools
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
        </div>

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
              bulkAssignMutation.isPending ||
              (!isBuiltinArchestraTool &&
                ((isLocalServer && !executionSourceMcpServerId) ||
                  (!isLocalServer && !credentialSourceMcpServerId)))
            }
          >
            {bulkAssignMutation.isPending
              ? "Assigning..."
              : `Assign to ${selectedProfileIds.length} profile${selectedProfileIds.length !== 1 ? "s" : ""}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

"use client";

import { MCP_SERVER_TOOL_NAME_SEPARATOR } from "@shared";
import { Loader2, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  useConversationEnabledTools,
  useProfileToolsWithIds,
  useUpdateConversationEnabledTools,
} from "@/lib/chat.query";
import { AssignToolsToProfile } from "./assign-tools-to-profile";

interface ManageChatToolsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  agentId: string;
  /** Tool IDs to pre-uncheck when opening the dialog */
  initialDisabledToolIds?: string[];
}

interface ToolWithId {
  id: string;
  name: string;
  description: string | null;
}

/**
 * Extract server name from a tool name
 * Tool names are formatted as: serverName__toolName
 */
function getServerName(toolName: string): string {
  const parts = toolName.split(MCP_SERVER_TOOL_NAME_SEPARATOR);
  return parts.length > 1
    ? parts.slice(0, -1).join(MCP_SERVER_TOOL_NAME_SEPARATOR)
    : "default";
}

/**
 * Extract the tool's short name (without server prefix)
 */
function getToolShortName(toolName: string): string {
  const parts = toolName.split(MCP_SERVER_TOOL_NAME_SEPARATOR);
  return parts.length > 1 ? parts[parts.length - 1] : toolName;
}

/**
 * Group tools by server name
 */
function groupToolsByServer(tools: ToolWithId[]): Record<string, ToolWithId[]> {
  return tools.reduce(
    (acc, tool) => {
      const serverName = getServerName(tool.name);
      if (!acc[serverName]) {
        acc[serverName] = [];
      }
      acc[serverName].push(tool);
      return acc;
    },
    {} as Record<string, ToolWithId[]>,
  );
}

export function ManageChatToolsDialog({
  open,
  onOpenChange,
  conversationId,
  agentId,
  initialDisabledToolIds = [],
}: ManageChatToolsDialogProps) {
  // Fetch profile tools with IDs
  const { data: profileTools = [], isLoading: isLoadingTools } =
    useProfileToolsWithIds(agentId);

  // Fetch current enabled tools state
  const { data: enabledToolsData, isLoading: isLoadingEnabled } =
    useConversationEnabledTools(conversationId);

  // Mutation to update enabled tools
  const updateEnabledTools = useUpdateConversationEnabledTools();

  // Local state for pending changes (tool IDs that are checked)
  const [checkedToolIds, setCheckedToolIds] = useState<Set<string>>(new Set());
  const [isInitialized, setIsInitialized] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  // Initialize local state when dialog opens
  useEffect(() => {
    if (open && profileTools.length > 0 && !isInitialized) {
      let initialChecked: Set<string>;

      if (enabledToolsData?.hasCustomSelection) {
        // Use saved selection
        initialChecked = new Set(enabledToolsData.enabledToolIds);
      } else {
        // All tools enabled by default
        initialChecked = new Set(profileTools.map((t) => t.id));
      }

      // Apply initial disabled tools (from X button clicks)
      for (const toolId of initialDisabledToolIds) {
        initialChecked.delete(toolId);
      }

      setCheckedToolIds(initialChecked);
      setIsInitialized(true);
    }
  }, [
    open,
    profileTools,
    enabledToolsData,
    initialDisabledToolIds,
    isInitialized,
  ]);

  // Reset initialization flag when dialog closes
  useEffect(() => {
    if (!open) {
      setIsInitialized(false);
      setSearchQuery("");
    }
  }, [open]);

  // Filter tools by search query
  const filteredTools = useMemo(() => {
    if (!searchQuery.trim()) {
      return profileTools;
    }
    const query = searchQuery.toLowerCase().trim();
    return profileTools.filter((tool) => {
      const shortName = getToolShortName(tool.name).toLowerCase();
      const description = (tool.description || "").toLowerCase();
      const serverName = getServerName(tool.name).toLowerCase();
      return (
        shortName.includes(query) ||
        description.includes(query) ||
        serverName.includes(query)
      );
    });
  }, [profileTools, searchQuery]);

  // Group tools by server
  const groupedTools = useMemo(
    () => groupToolsByServer(filteredTools),
    [filteredTools],
  );

  // Handle individual tool toggle
  const handleToolToggle = useCallback((toolId: string, checked: boolean) => {
    setCheckedToolIds((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(toolId);
      } else {
        next.delete(toolId);
      }
      return next;
    });
  }, []);

  // Handle server-level toggle (select/unselect all)
  const handleToggleServer = useCallback(
    (serverName: string, checked: boolean) => {
      const serverTools = groupedTools[serverName] || [];
      setCheckedToolIds((prev) => {
        const next = new Set(prev);
        if (checked) {
          for (const tool of serverTools) {
            next.add(tool.id);
          }
        } else {
          for (const tool of serverTools) {
            next.delete(tool.id);
          }
        }
        return next;
      });
    },
    [groupedTools],
  );

  // Handle save
  const handleSave = useCallback(async () => {
    const toolIds = Array.from(checkedToolIds);
    await updateEnabledTools.mutateAsync({
      conversationId,
      toolIds,
    });
    onOpenChange(false);
  }, [checkedToolIds, conversationId, updateEnabledTools, onOpenChange]);

  // Handle cancel
  const handleCancel = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const isLoading = isLoadingTools || isLoadingEnabled;
  const isSaving = updateEnabledTools.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Manage Tools for This Chat</DialogTitle>
          <DialogDescription>
            Select which tools are available in this chat session.
          </DialogDescription>
          <DialogDescription>
            Don't see the tools you need?{" "}
            <div className="inline-block">
              <AssignToolsToProfile
                agentId={agentId}
                showAssignedToolsList={false}
                assignToolsButtonProps={{
                  variant: "link",
                  size: "sm",
                  className: "text-xs",
                }}
              />
            </div>
          </DialogDescription>
        </DialogHeader>

        {!isLoading && (
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="text"
              placeholder="Search tools..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>
        )}

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : Object.keys(groupedTools).length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            {searchQuery.trim()
              ? "No tools found matching your search."
              : "No tools assigned to this profile."}
          </div>
        ) : (
          <ScrollArea className="max-h-[50vh] pr-4">
            <div className="space-y-6">
              {Object.entries(groupedTools).map(([serverName, tools]) => {
                const allChecked = tools.every((t) => checkedToolIds.has(t.id));

                return (
                  <div key={serverName} className="space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id={`server-${serverName}`}
                          checked={allChecked}
                          onCheckedChange={(checked) =>
                            handleToggleServer(serverName, checked === true)
                          }
                        />
                        <label
                          htmlFor={`server-${serverName}`}
                          className="text-sm font-medium cursor-pointer"
                        >
                          {serverName}
                        </label>
                      </div>
                    </div>
                    <div className="space-y-2 pl-8">
                      {tools.map((tool) => {
                        const shortName = getToolShortName(tool.name);
                        const isChecked = checkedToolIds.has(tool.id);

                        return (
                          <div key={tool.id} className="flex items-start gap-3">
                            <Checkbox
                              id={`tool-${tool.id}`}
                              checked={isChecked}
                              onCheckedChange={(checked) =>
                                handleToolToggle(tool.id, checked === true)
                              }
                              className="mt-0.5"
                            />
                            <label
                              htmlFor={`tool-${tool.id}`}
                              className="flex-1 cursor-pointer"
                            >
                              <div className="text-sm font-mono">
                                {shortName}
                              </div>
                              {tool.description && (
                                <div className="text-xs text-muted-foreground mt-0.5">
                                  {tool.description}
                                </div>
                              )}
                            </label>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        )}

        <DialogFooter className="gap-4">
          <Button variant="outline" onClick={handleCancel} disabled={isSaving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isSaving || isLoading}>
            {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

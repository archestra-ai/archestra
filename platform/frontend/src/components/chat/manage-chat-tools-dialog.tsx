"use client";

import {
  isArchestraMcpServerTool,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@shared";
import { Loader2 } from "lucide-react";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  useConversationEnabledTools,
  useProfileToolsWithIds,
  useUpdateConversationEnabledTools,
} from "@/lib/chat.query";

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
    }
  }, [open]);

  // Filter out Archestra tools (they cannot be disabled)
  const manageableTools = useMemo(
    () =>
      (profileTools as ToolWithId[]).filter(
        (tool) => !isArchestraMcpServerTool(tool.name),
      ),
    [profileTools],
  );

  // Group tools by server
  const groupedTools = useMemo(
    () => groupToolsByServer(manageableTools),
    [manageableTools],
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

  // Handle server-level enable all
  const handleEnableAllServer = useCallback(
    (serverName: string) => {
      const serverTools = groupedTools[serverName] || [];
      setCheckedToolIds((prev) => {
        const next = new Set(prev);
        for (const tool of serverTools) {
          next.add(tool.id);
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
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : Object.keys(groupedTools).length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No tools assigned to this profile.
          </div>
        ) : (
          <ScrollArea className="max-h-[50vh] pr-4">
            <div className="space-y-6">
              {Object.entries(groupedTools).map(([serverName, tools]) => {
                const allChecked = tools.every((t) => checkedToolIds.has(t.id));

                return (
                  <div key={serverName} className="space-y-3">
                    <div className="flex items-center justify-between">
                      <h4 className="text-sm font-medium">{serverName}</h4>
                      {!allChecked && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => handleEnableAllServer(serverName)}
                        >
                          Enable All
                        </Button>
                      )}
                    </div>
                    <div className="space-y-2 pl-1">
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

        <DialogFooter className="gap-2 sm:gap-0">
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

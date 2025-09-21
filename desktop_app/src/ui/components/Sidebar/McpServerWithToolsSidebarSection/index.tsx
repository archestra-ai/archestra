import { CheckedState } from '@radix-ui/react-checkbox';
import { useNavigate } from '@tanstack/react-router';
import { AlertCircle, ChevronDown, ChevronRight, Loader2, Plus, PlusCircle } from 'lucide-react';
import { useEffect, useState } from 'react';

import { deconstructToolId } from '@constants';
import { ToolHoverCard } from '@ui/components/ToolHoverCard';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@ui/components/ui/collapsible';
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@ui/components/ui/sidebar';
import { formatToolName } from '@ui/lib/utils/tools';
import { useMcpServersStore, useToolsStore } from '@ui/stores';

interface McpServerWithToolsSidebarSectionProps {}

export default function McpServerWithToolsSidebarSection(_props: McpServerWithToolsSidebarSectionProps) {
  const navigate = useNavigate();

  const { availableTools, loadingAvailableTools, selectedToolIds, addSelectedTool, removeSelectedTool } =
    useToolsStore();
  const { installedMcpServers } = useMcpServersStore();

  const [expandedServers, setExpandedServers] = useState<Set<string>>(new Set());
  const [hasInitialized, setHasInitialized] = useState(false);

  // Helper function to check if server is still initializing
  const isServerInitializing = (serverId: string): boolean => {
    // Only check installed MCP servers (not Archestra which is always ready)
    const mcpServer = installedMcpServers.find((s) => s.id === serverId);

    if (!mcpServer) return false;

    // Server is initializing if in these states (including error state)
    return (
      mcpServer.state === 'not_created' ||
      mcpServer.state === 'created' ||
      mcpServer.state === 'initializing' ||
      mcpServer.state === 'error'
    );
  };

  // Helper function to find common prefix
  const findCommonPrefix = (tools: typeof availableTools): string => {
    if (tools.length === 0) return '';

    const names = tools.map((t) => formatToolName(t.name || t.id));
    if (names.length === 1) return '';

    let prefix = '';
    const minLength = Math.min(...names.map((n) => n.length));

    for (let i = 0; i < minLength; i++) {
      const char = names[0][i];
      if (names.every((name) => name[i] === char)) {
        prefix += char;
      } else {
        break;
      }
    }

    // Only remove prefix if it ends with a separator like _ or -
    const lastChar = prefix[prefix.length - 1];
    if (lastChar === '_' || lastChar === '-' || lastChar === '.') {
      return prefix;
    }

    // Or if the prefix is a complete word (next char is uppercase or separator)
    if (
      prefix.length > 0 &&
      names.every((name) => {
        const nextChar = name[prefix.length];
        return (
          !nextChar || nextChar === '_' || nextChar === '-' || nextChar === '.' || nextChar === nextChar.toUpperCase()
        );
      })
    ) {
      return prefix;
    }

    return '';
  };

  // Initialize - mark as initialized but keep servers collapsed
  useEffect(() => {
    if (availableTools.length > 0 && !hasInitialized) {
      // Don't expand any servers by default - start with all collapsed
      setHasInitialized(true);
    }
  }, [availableTools, hasInitialized]);

  // Step 1: Filter and group UNSELECTED tools by server
  const toolsByServer = availableTools
    .filter((tool) => {
      // Only show tools that are NOT selected
      const isSelected = selectedToolIds.has(tool.id);
      return !isSelected;
    })
    .reduce(
      (
        acc: Record<
          string,
          {
            tools: typeof availableTools;
            commonPrefix: string;
            serverId: string;
            readOnlyCount: number;
            writeOnlyCount: number;
            readWriteCount: number;
            otherCount: number;
          }
        >,
        tool
      ) => {
        const serverName = tool.mcpServerName || 'Unknown';
        const serverId = deconstructToolId(tool.id).serverName;

        if (!acc[serverName]) {
          acc[serverName] = {
            tools: [],
            commonPrefix: '',
            serverId: serverId,
            readOnlyCount: 0,
            writeOnlyCount: 0,
            readWriteCount: 0,
            otherCount: 0,
          };
        }
        acc[serverName].tools.push(tool);

        // Count tool types
        const isRead = tool.analysis?.is_read ?? false;
        const isWrite = tool.analysis?.is_write ?? false;

        if (isRead && isWrite) {
          acc[serverName].readWriteCount++;
        } else if (isRead) {
          acc[serverName].readOnlyCount++;
        } else if (isWrite) {
          acc[serverName].writeOnlyCount++;
        } else {
          acc[serverName].otherCount++;
        }

        return acc;
      },
      {}
    );

  // Step 2: Add MCP servers that don't have unselected tools
  installedMcpServers.forEach((server) => {
    // Check if this server already has unselected tools showing
    const serverAlreadyShowing = Object.values(toolsByServer).some((group) => group.serverId === server.id);

    // If server is not already showing, add it (regardless of state)
    // This ensures running servers without tools still appear as "Loading..."
    // BUT don't overwrite if it already exists (which would clear the tools)
    if (!serverAlreadyShowing && !toolsByServer[server.name]) {
      toolsByServer[server.name] = {
        tools: [],
        commonPrefix: '',
        serverId: server.id,
        readOnlyCount: 0,
        writeOnlyCount: 0,
        readWriteCount: 0,
        otherCount: 0,
      };
    }
  });

  // Step 3: Calculate common prefixes for tool names and sort tools
  Object.values(toolsByServer).forEach((group) => {
    group.commonPrefix = findCommonPrefix(group.tools);

    // Sort tools: Read-only first, then Read/Write, then Write-only, then others
    group.tools.sort((a, b) => {
      const aRead = a.analysis?.is_read ?? false;
      const aWrite = a.analysis?.is_write ?? false;
      const bRead = b.analysis?.is_read ?? false;
      const bWrite = b.analysis?.is_write ?? false;

      // Calculate priority (lower number = higher priority)
      const getPriority = (isRead: boolean, isWrite: boolean) => {
        if (isRead && !isWrite) return 0; // Read-only
        if (isRead && isWrite) return 1; // Read/Write
        if (!isRead && isWrite) return 2; // Write-only
        return 3; // No analysis or neither
      };

      const aPriority = getPriority(aRead, aWrite);
      const bPriority = getPriority(bRead, bWrite);

      // Sort by priority, then alphabetically by name
      if (aPriority !== bPriority) {
        return aPriority - bPriority;
      }
      return (a.name || a.id).localeCompare(b.name || b.id);
    });
  });

  const hasContent = Object.keys(toolsByServer).length > 0;

  // Toggle server expansion
  const toggleServerExpansion = (serverName: string) => {
    setExpandedServers((prev) => {
      const next = new Set(prev);
      if (next.has(serverName)) {
        next.delete(serverName);
      } else {
        next.add(serverName);
      }
      return next;
    });
  };

  // Handle tool selection
  const handleToolToggle = (toolId: string, checked: CheckedState) => {
    if (checked) {
      addSelectedTool(toolId);
    } else {
      removeSelectedTool(toolId);
    }
  };

  // Calculate unused tools count
  const unusedToolsCount = availableTools.length - selectedToolIds.size;

  return (
    <SidebarGroup className="group-data-[collapsible=icon]:hidden">
      <SidebarGroupLabel>Unused tools: {unusedToolsCount}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {loadingAvailableTools ? (
            // Show loading state while fetching tools
            <SidebarMenuItem>
              <div className="flex items-center gap-2 px-2 py-1.5">
                <div className="h-3 w-3 animate-spin rounded-full border border-muted-foreground border-t-transparent" />
                <span className="text-xs text-muted-foreground">Loading tools...</span>
              </div>
            </SidebarMenuItem>
          ) : !hasContent ? (
            // No unselected tools to show
            <SidebarMenuItem>
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                {selectedToolIds.size === availableTools.length && availableTools.length > 0
                  ? 'All tools are selected'
                  : 'No tools available'}
              </div>
            </SidebarMenuItem>
          ) : (
            <>
              {Object.entries(toolsByServer).map(([serverName, serverData]) => {
                const isExpanded = expandedServers.has(serverName);
                const isInitializing = isServerInitializing(serverData.serverId);
                const serverState = installedMcpServers.find((s) => s.id === serverData.serverId)?.state;
                const isError = serverState === 'error';
                const hasTools = serverData.tools.length > 0;

                return (
                  <Collapsible
                    key={serverName}
                    open={isExpanded}
                    onOpenChange={() => toggleServerExpansion(serverName)}
                  >
                    <SidebarMenuItem
                      className={`flex items-center gap-1 px-2 py-1.5 rounded transition-colors bg-muted/50 ${hasTools ? 'hover:bg-muted/70' : 'opacity-60'}`}
                    >
                      <CollapsibleTrigger
                        className={`w-full flex-1 ${hasTools ? 'cursor-pointer' : 'cursor-not-allowed'}`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0 flex-1">
                            {(() => {
                              // Check the actual server state to determine what icon to show
                              const server = installedMcpServers.find((s) => s.id === serverData.serverId);
                              const isActuallyInitializing =
                                server &&
                                (server.state === 'not_created' ||
                                  server.state === 'created' ||
                                  server.state === 'initializing');

                              if (isError) {
                                return <AlertCircle className="h-3 w-3 text-red-500 flex-shrink-0" />;
                              }
                              if (hasTools && isActuallyInitializing) {
                                return <Loader2 className="h-3 w-3 animate-spin text-muted-foreground flex-shrink-0" />;
                              }
                              return null;
                            })()}
                            <span className="text-sm font-medium capitalize truncate">{serverName}</span>
                          </div>
                        </div>
                        <div className="text-xs text-muted-foreground mt-0.5 text-left">
                          {(() => {
                            if (isError) {
                              return 'Error';
                            }

                            // Check the actual server state to determine what to show
                            const server = installedMcpServers.find((s) => s.id === serverData.serverId);
                            const isActuallyInitializing =
                              server &&
                              (server.state === 'not_created' ||
                                server.state === 'created' ||
                                server.state === 'initializing');

                            // Show "Loading..." only for servers that are actually initializing
                            if (!hasTools) {
                              if (isActuallyInitializing) {
                                return 'Loading...';
                              }
                              // Server is running or in another state but has no tools
                              return 'No tools available';
                            }

                            const parts = [];
                            if (serverData.readOnlyCount > 0) parts.push(`${serverData.readOnlyCount} read`);
                            if (serverData.writeOnlyCount > 0) parts.push(`${serverData.writeOnlyCount} write`);
                            if (serverData.readWriteCount > 0) parts.push(`${serverData.readWriteCount} read/write`);
                            if (serverData.otherCount > 0) parts.push(`${serverData.otherCount} other`);
                            return parts.length > 0 ? parts.join(' + ') : 'No tools';
                          })()}
                        </div>
                      </CollapsibleTrigger>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (hasTools) {
                            // Add all tools from this server
                            serverData.tools.forEach((tool) => addSelectedTool(tool.id));
                          }
                        }}
                        title={
                          isError
                            ? `${serverName} has an error`
                            : !hasTools
                              ? `${serverName} is loading tools`
                              : `Add all ${serverName} tools`
                        }
                        disabled={!hasTools}
                      >
                        <PlusCircle className="h-4 w-4 cursor-pointer" />
                      </button>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        {isExpanded ? (
                          <ChevronDown className="h-3 w-3 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-3 w-3 text-muted-foreground" />
                        )}
                      </div>
                    </SidebarMenuItem>

                    <CollapsibleContent>
                      {!hasTools ? (
                        <SidebarMenuItem>
                          <div className="px-4 py-2 text-xs text-muted-foreground italic">
                            {isError ? 'Server error - check Settings' : 'Loading tools...'}
                          </div>
                        </SidebarMenuItem>
                      ) : (
                        serverData.tools.map((tool) => {
                          const {
                            id,
                            name,
                            analysis: { status },
                          } = tool;

                          const fullName = formatToolName(name || id);
                          const displayName = serverData.commonPrefix
                            ? fullName.slice(serverData.commonPrefix.length)
                            : fullName;

                          return (
                            <SidebarMenuItem key={id}>
                              <ToolHoverCard
                                tool={tool}
                                side="right"
                                align="start"
                                showInstructions={!isInitializing}
                                instructionText={
                                  isInitializing
                                    ? 'Server is still initializing'
                                    : 'Click to add this tool to your chat'
                                }
                              >
                                <div
                                  className={`flex items-center gap-2 px-2 py-1.5 text-sm rounded-md w-full ${isInitializing ? 'opacity-50 cursor-not-allowed' : 'hover:bg-muted/50 cursor-pointer'}`}
                                  onClick={() => {
                                    if (!isInitializing) {
                                      handleToolToggle(id, true);
                                    }
                                  }}
                                  title={isInitializing ? `${serverName} is still initializing` : fullName}
                                >
                                  {status === 'awaiting_ollama_model' || status === 'in_progress' ? (
                                    <div className="w-2 h-2 border border-muted-foreground rounded-full animate-spin border-t-transparent flex-shrink-0" />
                                  ) : status === 'error' ? (
                                    <div className="w-2 h-2 bg-red-500 rounded-full flex-shrink-0" />
                                  ) : isInitializing ? (
                                    <div className="w-2 h-2 bg-yellow-500 rounded-full flex-shrink-0" />
                                  ) : (
                                    <div
                                      className={`w-2 h-2 rounded-full flex-shrink-0 ${
                                        tool.analysis?.is_read && tool.analysis?.is_write
                                          ? 'bg-blue-500'
                                          : tool.analysis?.is_write
                                            ? 'bg-orange-500'
                                            : tool.analysis?.is_read
                                              ? 'bg-green-500'
                                              : 'bg-gray-500'
                                      }`}
                                    />
                                  )}
                                  <span className="truncate flex-1">{displayName}</span>
                                </div>
                              </ToolHoverCard>
                            </SidebarMenuItem>
                          );
                        })
                      )}
                    </CollapsibleContent>
                  </Collapsible>
                );
              })}

              <SidebarMenuItem>
                <SidebarMenuButton
                  size="sm"
                  className="justify-start text-muted-foreground cursor-pointer"
                  onClick={() => navigate({ to: '/connectors' })}
                >
                  <Plus className="h-4 w-4" />
                  <span>Add more</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </>
          )}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

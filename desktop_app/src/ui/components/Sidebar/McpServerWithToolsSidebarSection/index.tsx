import { CheckedState } from '@radix-ui/react-checkbox';
import { useNavigate } from '@tanstack/react-router';
import { AlertCircle, ChevronDown, ChevronRight, Loader2, Plus, PlusCircle } from 'lucide-react';
import { useEffect, useState } from 'react';

import { ToolHoverCard } from '@ui/components/ToolHoverCard';
import { Checkbox } from '@ui/components/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@ui/components/ui/collapsible';
import { Input } from '@ui/components/ui/input';
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

  const [toolSearchQuery, setToolSearchQuery] = useState('');
  const { availableTools, loadingAvailableTools, selectedToolIds, addSelectedTool, removeSelectedTool } =
    useToolsStore();
  const { installedMcpServers, archestraMcpServer } = useMcpServersStore();

  const [expandedServers, setExpandedServers] = useState<Set<string>>(new Set());
  const [hasInitialized, setHasInitialized] = useState(false);

  // Helper function to extract server ID from tool ID (format: serverId__toolName)
  const extractServerIdFromToolId = (toolId: string): string => {
    const parts = toolId.split('__');
    return parts[0] || '';
  };

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

  const toolSearchQueryIsEmpty = !toolSearchQuery.trim();

  // Step 1: Filter and group UNSELECTED tools by server
  const toolsByServer = availableTools
    .filter((tool) => {
      // Only show tools that are NOT selected
      if (selectedToolIds.has(tool.id)) return false;

      // Apply search filter if searching
      if (!toolSearchQueryIsEmpty) {
        const searchLower = toolSearchQuery.toLowerCase();
        return (
          tool.name?.toLowerCase().includes(searchLower) ||
          tool.description?.toLowerCase().includes(searchLower) ||
          tool.mcpServerName?.toLowerCase().includes(searchLower)
        );
      }

      return true;
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
        const serverId = extractServerIdFromToolId(tool.id);

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

  // Step 2: Add MCP servers that are still initializing (only when not searching)
  if (toolSearchQueryIsEmpty) {
    installedMcpServers.forEach((server) => {
      // Show servers that are initializing OR in error state
      const isInitializing =
        server.state === 'not_created' ||
        server.state === 'created' ||
        server.state === 'initializing' ||
        server.state === 'error';

      if (!isInitializing) return;

      // Check if this server already has unselected tools showing
      const serverAlreadyShowing = Object.values(toolsByServer).some((group) => group.serverId === server.id);

      // If server is initializing and not already showing, add it
      if (!serverAlreadyShowing) {
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
  }

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
        <div className="px-4 pb-2">
          <Input
            placeholder="Search tools..."
            value={toolSearchQuery}
            onChange={(e) => setToolSearchQuery(e.target.value)}
            className="h-7 text-xs"
          />
        </div>
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
                {toolSearchQuery
                  ? `No tools found matching "${toolSearchQuery}"`
                  : selectedToolIds.size === availableTools.length && availableTools.length > 0
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
                return (
                  <Collapsible
                    key={serverName}
                    open={isExpanded}
                    onOpenChange={() => toggleServerExpansion(serverName)}
                  >
                    <SidebarMenuItem>
                      <div className="flex items-center gap-1">
                        <CollapsibleTrigger className="flex-1 min-w-0">
                          <div
                            className={`px-2 py-1.5 bg-muted/50 rounded-md transition-colors w-full ${isInitializing && !isError ? 'opacity-60' : 'cursor-pointer hover:bg-muted/70'}`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-2 min-w-0 flex-1">
                                {isInitializing && !isError && (
                                  <Loader2 className="h-3 w-3 animate-spin text-muted-foreground flex-shrink-0" />
                                )}
                                {isError && <AlertCircle className="h-3 w-3 text-red-500 flex-shrink-0" />}
                                <span className="text-sm font-medium capitalize truncate">{serverName}</span>
                              </div>
                              <div className="flex items-center gap-1 flex-shrink-0">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (!isInitializing || (isInitializing && serverData.tools.length > 0)) {
                                      // Add all tools from this server
                                      serverData.tools.forEach((tool) => addSelectedTool(tool.id));
                                    }
                                  }}
                                  className={`p-0.5 rounded transition-colors ${isInitializing && serverData.tools.length === 0 ? 'opacity-50 cursor-not-allowed' : 'hover:bg-muted-foreground/20'}`}
                                  title={
                                    isError
                                      ? `${serverName} has an error`
                                      : isInitializing && serverData.tools.length === 0
                                        ? `${serverName} is still initializing`
                                        : `Add all ${serverName} tools`
                                  }
                                  disabled={isInitializing && serverData.tools.length === 0}
                                >
                                  <PlusCircle
                                    className={`h-4 w-4 ${isInitializing && serverData.tools.length === 0 ? 'text-muted-foreground/50' : 'text-muted-foreground hover:text-foreground'}`}
                                  />
                                </button>
                                {isExpanded ? (
                                  <ChevronDown className="h-3 w-3 text-muted-foreground" />
                                ) : (
                                  <ChevronRight className="h-3 w-3 text-muted-foreground" />
                                )}
                              </div>
                            </div>
                            <div className="text-xs text-muted-foreground mt-0.5 text-left">
                              {(() => {
                                if (isInitializing && !isError && serverData.tools.length === 0) {
                                  return 'Loading...';
                                }
                                if (isError) {
                                  return 'Error';
                                }
                                const parts = [];
                                if (serverData.readOnlyCount > 0) parts.push(`${serverData.readOnlyCount} read`);
                                if (serverData.writeOnlyCount > 0) parts.push(`${serverData.writeOnlyCount} write`);
                                if (serverData.readWriteCount > 0)
                                  parts.push(`${serverData.readWriteCount} read/write`);
                                if (serverData.otherCount > 0) parts.push(`${serverData.otherCount} other`);
                                return parts.length > 0 ? parts.join(' + ') : 'No tools';
                              })()}
                            </div>
                          </div>
                        </CollapsibleTrigger>
                      </div>
                    </SidebarMenuItem>

                    <CollapsibleContent>
                      {serverData.tools.length === 0 ? (
                        <SidebarMenuItem>
                          <div className="px-4 py-2 text-xs text-muted-foreground italic">
                            {isError
                              ? 'Server error - check Settings'
                              : isInitializing
                                ? 'Loading tools...'
                                : 'No tools available'}
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

              {toolSearchQueryIsEmpty && (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    size="sm"
                    className="justify-start text-muted-foreground"
                    onClick={() => navigate({ to: '/connectors' })}
                  >
                    <Plus className="h-4 w-4" />
                    <span>Add more</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
            </>
          )}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

import { CheckedState } from '@radix-ui/react-checkbox';
import { useNavigate } from '@tanstack/react-router';
import { ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';

import { ToolHoverCard } from '@ui/components/ToolHoverCard';
import { ToolServerIcon } from '@ui/components/ToolServerIcon';
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
import { useToolsStore } from '@ui/stores';

interface McpServerWithToolsSidebarSectionProps {}

export default function McpServerWithToolsSidebarSection(_props: McpServerWithToolsSidebarSectionProps) {
  const navigate = useNavigate();

  const [toolSearchQuery, setToolSearchQuery] = useState('');
  const { availableTools, loadingAvailableTools, selectedToolIds, addSelectedTool, removeSelectedTool } =
    useToolsStore();

  const [expandedServers, setExpandedServers] = useState<Set<string>>(new Set());

  // Initialize all servers as expanded on first load
  useEffect(() => {
    if (availableTools.length > 0 && expandedServers.size === 0) {
      const serverNames = new Set(availableTools.map((t) => t.mcpServerName || 'Unknown'));
      setExpandedServers(serverNames);
    }
  }, [availableTools, expandedServers.size]);

  // Filter and group tools based on search query
  const toolsByServer = availableTools
    .filter((tool) => {
      if (!toolSearchQuery.trim()) return true;
      const searchLower = toolSearchQuery.toLowerCase();
      return (
        tool.name?.toLowerCase().includes(searchLower) ||
        tool.description?.toLowerCase().includes(searchLower) ||
        tool.mcpServerName?.toLowerCase().includes(searchLower)
      );
    })
    .reduce((acc: Record<string, typeof availableTools>, tool) => {
      const serverName = tool.mcpServerName || 'Unknown';
      if (!acc[serverName]) {
        acc[serverName] = [];
      }
      acc[serverName].push(tool);
      return acc;
    }, {});

  const hasTools = Object.keys(toolsByServer).length > 0;
  const toolSearchQueryIsEmpty = !toolSearchQuery.trim();

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

  return (
    <SidebarGroup className="group-data-[collapsible=icon]:hidden">
      <SidebarGroupLabel>
        Tools
        {selectedToolIds.size > 0 && (
          <span className="ml-2 px-1.5 py-0.5 text-xs bg-primary/10 text-primary rounded-full">
            {selectedToolIds.size}
          </span>
        )}
      </SidebarGroupLabel>
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
            <SidebarMenuItem>
              <div className="flex items-center gap-2 px-2 py-1.5">
                <div className="h-3 w-3 animate-spin rounded-full border border-muted-foreground border-t-transparent" />
                <span className="text-xs text-muted-foreground">Loading...</span>
              </div>
            </SidebarMenuItem>
          ) : !hasTools ? (
            <SidebarMenuItem>
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                {toolSearchQuery ? `No tools found matching "${toolSearchQuery}"` : 'No tools available'}
              </div>
            </SidebarMenuItem>
          ) : (
            <>
              {Object.entries(toolsByServer).map(([serverName, serverTools]) => {
                const isExpanded = expandedServers.has(serverName);
                return (
                  <Collapsible
                    key={serverName}
                    open={isExpanded}
                    onOpenChange={() => toggleServerExpansion(serverName)}
                  >
                    <SidebarMenuItem>
                      <CollapsibleTrigger className="w-full">
                        <div className="flex items-center justify-between gap-2 px-2 py-1.5 bg-muted/50 rounded-md cursor-pointer hover:bg-muted/70 transition-colors w-full">
                          <div className="flex items-center gap-2 min-w-0 flex-1">
                            <ToolServerIcon
                              toolServerName={serverName}
                              widthHeightClassName="w-4 h-4"
                              textClassName="text-[10px]"
                            />
                            <span className="text-sm font-medium capitalize truncate">{serverName}</span>
                          </div>
                          {isExpanded ? (
                            <ChevronDown className="h-3 w-3 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="h-3 w-3 text-muted-foreground" />
                          )}
                        </div>
                      </CollapsibleTrigger>
                    </SidebarMenuItem>

                    <CollapsibleContent>
                      {serverTools.map((tool) => {
                        const {
                          id,
                          name,
                          analysis: { status },
                        } = tool;

                        return (
                          <SidebarMenuItem key={id}>
                            <ToolHoverCard
                              tool={tool}
                              side="right"
                              align="start"
                              showInstructions={true}
                              instructionText="Check the box to enable this tool in your chat"
                            >
                              <div className="flex items-center gap-2 px-2 py-1.5 text-sm hover:bg-muted/50 rounded-md cursor-pointer w-full">
                                <Checkbox
                                  checked={selectedToolIds.has(id)}
                                  onCheckedChange={(checked) => handleToolToggle(id, checked)}
                                  onClick={(e) => e.stopPropagation()}
                                  className="h-3 w-3"
                                />
                                {status === 'awaiting_ollama_model' || status === 'in_progress' ? (
                                  <div className="w-2 h-2 border border-muted-foreground rounded-full animate-spin border-t-transparent flex-shrink-0" />
                                ) : status === 'error' ? (
                                  <div className="w-2 h-2 bg-red-500 rounded-full flex-shrink-0" />
                                ) : (
                                  <div className="w-2 h-2 bg-green-500 rounded-full flex-shrink-0" />
                                )}
                                <span className="truncate flex-1">{formatToolName(name || id)}</span>
                              </div>
                            </ToolHoverCard>
                          </SidebarMenuItem>
                        );
                      })}
                    </CollapsibleContent>
                  </Collapsible>
                );
              })}

              {(toolSearchQueryIsEmpty || !hasTools) && (
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

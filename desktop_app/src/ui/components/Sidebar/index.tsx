import { Link, useLocation } from '@tanstack/react-router';
import { Bot, ChevronRight, Download, MessageCircle, Settings } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import MemoryIndicator from '@ui/components/MemoryIndicator';
import { SiteHeader } from '@ui/components/SiteHeader';
import StatusBar from '@ui/components/StatusBar';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@ui/components/ui/collapsible';
import {
  Sidebar as SidebarBase,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
} from '@ui/components/ui/sidebar';

import ChatSidebarSection from './ChatSidebarSection';
import McpServerWithToolsSidebarSection from './McpServerWithToolsSidebarSection';

interface SidebarProps extends React.PropsWithChildren {}

export default function Sidebar({ children }: SidebarProps) {
  const location = useLocation();
  const isChat = location.pathname.startsWith('/chat');
  const [llmProvidersOpen, setLlmProvidersOpen] = useState(location.pathname.startsWith('/llm-providers'));
  const [settingsOpen, setSettingsOpen] = useState(location.pathname.startsWith('/settings'));

  return (
    <div className="[--header-height:2.25rem] h-screen flex flex-col">
      <SidebarProvider className="flex flex-col flex-1">
        <SiteHeader />
        <div className="flex flex-1 overflow-hidden">
          <SidebarBase
            collapsible="icon"
            className="border-r top-[var(--header-height)] h-[calc(100svh-var(--header-height))]"
          >
            <SidebarContent>
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu>
                    <SidebarMenuItem>
                      <SidebarMenuButton asChild isActive={location.pathname.startsWith('/chat')}>
                        <Link to="/chat">
                          <MessageCircle className="h-4 w-4" />
                          <span>Agents</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                    {isChat && <ChatSidebarSection />}

                    <Collapsible open={llmProvidersOpen} onOpenChange={setLlmProvidersOpen}>
                      <SidebarMenuItem>
                        <CollapsibleTrigger asChild>
                          <SidebarMenuButton isActive={location.pathname.startsWith('/llm-providers')}>
                            <Download className="h-4 w-4" />
                            <span>LLM Providers</span>
                            <ChevronRight className="ml-auto h-4 w-4 transition-transform duration-200 data-[state=open]:rotate-90" />
                          </SidebarMenuButton>
                        </CollapsibleTrigger>
                        <CollapsibleContent>
                          <SidebarMenuSub>
                            <SidebarMenuSubItem>
                              <SidebarMenuSubButton asChild isActive={location.pathname === '/llm-providers/ollama'}>
                                <Link to="/llm-providers/ollama">
                                  <span>Ollama</span>
                                </Link>
                              </SidebarMenuSubButton>
                            </SidebarMenuSubItem>
                            <SidebarMenuSubItem>
                              <SidebarMenuSubButton asChild isActive={location.pathname === '/llm-providers/cloud'}>
                                <Link to="/llm-providers/cloud">
                                  <span>Cloud</span>
                                </Link>
                              </SidebarMenuSubButton>
                            </SidebarMenuSubItem>
                          </SidebarMenuSub>
                        </CollapsibleContent>
                      </SidebarMenuItem>
                    </Collapsible>

                    <SidebarMenuItem>
                      <SidebarMenuButton asChild isActive={location.pathname.startsWith('/connectors')}>
                        <Link to="/connectors">
                          <Bot className="h-4 w-4" />
                          <span>Connectors</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>

                    <Collapsible open={settingsOpen} onOpenChange={setSettingsOpen}>
                      <SidebarMenuItem>
                        <CollapsibleTrigger asChild>
                          <SidebarMenuButton isActive={location.pathname.startsWith('/settings')}>
                            <Settings className="h-4 w-4" />
                            <span>Settings</span>
                            <ChevronRight className="ml-auto h-4 w-4 transition-transform duration-200 data-[state=open]:rotate-90" />
                          </SidebarMenuButton>
                        </CollapsibleTrigger>
                        <CollapsibleContent>
                          <SidebarMenuSub>
                            <SidebarMenuSubItem>
                              <SidebarMenuSubButton asChild isActive={location.pathname === '/settings/mcp-servers'}>
                                <Link to="/settings/mcp-servers">
                                  <span>MCP Servers</span>
                                </Link>
                              </SidebarMenuSubButton>
                            </SidebarMenuSubItem>
                            <SidebarMenuSubItem>
                              <SidebarMenuSubButton asChild isActive={location.pathname === '/settings/mcp-clients'}>
                                <Link to="/settings/mcp-clients">
                                  <span>MCP Clients</span>
                                </Link>
                              </SidebarMenuSubButton>
                            </SidebarMenuSubItem>
                            <SidebarMenuSubItem>
                              <SidebarMenuSubButton asChild isActive={location.pathname === '/settings/ollama'}>
                                <Link to="/settings/ollama">
                                  <span>Ollama</span>
                                </Link>
                              </SidebarMenuSubButton>
                            </SidebarMenuSubItem>
                          </SidebarMenuSub>
                        </CollapsibleContent>
                      </SidebarMenuItem>
                    </Collapsible>
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
              {isChat && <McpServerWithToolsSidebarSection />}
            </SidebarContent>
            <SidebarFooter className="p-0 space-y-0">
              <div className="p-2 pb-0 space-y-2">
                <MemoryIndicator />
              </div>
              <StatusBar />
            </SidebarFooter>
          </SidebarBase>
          {children}
        </div>
      </SidebarProvider>
    </div>
  );
}

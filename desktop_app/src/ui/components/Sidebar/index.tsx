import { Link, useLocation } from '@tanstack/react-router';
import { Bot, Cloud, HardDrive, MessageCircle, Network } from 'lucide-react';
import React from 'react';

import MemoryIndicator from '@ui/components/MemoryIndicator';
import { SiteHeader } from '@ui/components/SiteHeader';
import StatusBar from '@ui/components/StatusBar';
import {
  Sidebar as SidebarBase,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from '@ui/components/ui/sidebar';

import ChatSidebarSection from './ChatSidebarSection';
import McpServerWithToolsSidebarSection from './McpServerWithToolsSidebarSection';

interface SidebarProps extends React.PropsWithChildren {}

export default function Sidebar({ children }: SidebarProps) {
  const location = useLocation();

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
                      <SidebarMenuButton asChild className="hover:bg-transparent">
                        <Link to="/chat">
                          <MessageCircle className="h-4 w-4" />
                          <span>Agents</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                    <ChatSidebarSection />

                    <SidebarMenuItem>
                      <SidebarMenuButton asChild isActive={location.pathname === '/llm-providers/ollama'}>
                        <Link to="/llm-providers/ollama">
                          <HardDrive className="h-4 w-4" />
                          <span>Local models</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>

                    <SidebarMenuItem>
                      <SidebarMenuButton asChild isActive={location.pathname === '/llm-providers/cloud'}>
                        <Link to="/llm-providers/cloud">
                          <Cloud className="h-4 w-4" />
                          <span>Cloud models</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>

                    <SidebarMenuItem>
                      <SidebarMenuButton asChild isActive={location.pathname.startsWith('/connectors')}>
                        <Link to="/connectors">
                          <Bot className="h-4 w-4" />
                          <span>MCP Connectors</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>

                    <SidebarMenuItem>
                      <SidebarMenuButton asChild isActive={location.pathname === '/settings/mcp-clients'}>
                        <Link to="/settings/mcp-clients">
                          <Network className="h-4 w-4" />
                          <span>Use as MCP Proxy</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
              <McpServerWithToolsSidebarSection />
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

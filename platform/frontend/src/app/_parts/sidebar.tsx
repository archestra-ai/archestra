"use client";
import type { LucideIcon } from "lucide-react";
import {
  BookOpen,
  Bot,
  Bug,
  FileJson2,
  Github,
  Info,
  MessagesSquare,
  Settings,
  ShieldCheck,
  Slack,
  Star,
} from "lucide-react";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ColorModeToggle } from "@/components/color-mode-toggle";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";

interface MenuItem {
  title: string;
  url: string;
  icon: LucideIcon;
  subItems?: MenuItem[];
}

const navigationItems: MenuItem[] = [
  {
    title: "How it works",
    url: "/test-agent",
    icon: Info,
  },
  {
    title: "Agents",
    url: "/agents",
    icon: Bot,
  },
  {
    title: "Logs",
    url: "/logs",
    icon: MessagesSquare,
  },
  {
    title: "Tools",
    url: "/tools",
    icon: FileJson2,
  },
  {
    title: "Settings",
    url: "/settings",
    icon: Settings,
  },
];

const actionItems: MenuItem[] = [
  {
    title: "Dual LLM",
    url: "/dual-llm",
    icon: ShieldCheck,
  },
];

export function AppSidebar() {
  const pathname = usePathname();
  const [starCount, setStarCount] = useState<number | null>(null);

  useEffect(() => {
    fetch("https://api.github.com/repos/archestra-ai/archestra")
      .then((response) => response.json())
      .then((data) => {
        if (data.stargazers_count) {
          setStarCount(data.stargazers_count);
        }
      })
      .catch((error) => console.error("Error fetching GitHub stars:", error));
  }, []);

  return (
    <Sidebar>
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-2">
          <Image src="/logo.png" alt="Logo" width={28} height={28} />
          <span className="text-base font-semibold">Archestra.AI</span>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup className="px-4">
          <SidebarGroupContent>
            <SidebarMenu>
              {navigationItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton asChild isActive={item.url === pathname}>
                    <a href={item.url}>
                      <item.icon />
                      <span>{item.title}</span>
                    </a>
                  </SidebarMenuButton>
                  {item.subItems && (
                    <SidebarMenuSub>
                      {item.subItems.map((subItem) => (
                        <SidebarMenuSubItem key={subItem.title}>
                          <SidebarMenuSubButton
                            asChild
                            isActive={subItem.url === pathname}
                          >
                            <a href={subItem.url}>
                              {subItem.icon && <subItem.icon />}
                              <span>{subItem.title}</span>
                            </a>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      ))}
                    </SidebarMenuSub>
                  )}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="px-4">
          <SidebarGroupLabel>Security sub-agents</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {actionItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton asChild isActive={item.url === pathname}>
                    <a href={item.url}>
                      <item.icon />
                      <span>{item.title}</span>
                    </a>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="px-4">
          <SidebarGroupLabel>Community</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild>
                  <a
                    href="https://github.com/archestra-ai/archestra"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Github />
                    <span className="flex items-center gap-2">
                      Star us on GitHub
                      <span className="flex items-center gap-1 text-xs">
                        <Star className="h-3 w-3" />
                        {starCount !== null
                          ? starCount.toLocaleString()
                          : "..."}
                      </span>
                    </span>
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild>
                  <a
                    href="https://www.archestra.ai/docs/"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <BookOpen />
                    <span>Documentation</span>
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild>
                  <a
                    href="https://join.slack.com/t/archestracommunity/shared_invite/zt-39yk4skox-zBF1NoJ9u4t59OU8XxQChg"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Slack />
                    <span>Talk to developers</span>
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild>
                  <a
                    href="https://github.com/archestra-ai/archestra/issues/new"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Bug />
                    <span>Report a bug</span>
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <div className="flex items-center justify-center py-2">
          <ColorModeToggle />
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}

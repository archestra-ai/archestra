"use client";
import {
  authLocalization,
  SignedIn,
  SignedOut,
  UserButton,
} from "@daveyplate/better-auth-ui";
import {
  BookOpen,
  Bot,
  Bug,
  FileJson2,
  Github,
  Info,
  LogIn,
  type LucideIcon,
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
import { DefaultCredentialsWarning } from "@/components/default-credentials-warning";
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
import { useIsAuthenticated } from "@/lib/auth.hook";

interface MenuItem {
  title: string;
  url: string;
  icon: LucideIcon;
  subItems?: MenuItem[];
}

const getNavigationItems = (isAuthenticated: boolean): MenuItem[] => {
  return [
    {
      title: "How it works",
      url: "/test-agent",
      icon: Info,
    },
    ...(isAuthenticated
      ? [
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
        ]
      : []),
  ];
};

const actionItems: MenuItem[] = [
  {
    title: "Dual LLM",
    url: "/dual-llm",
    icon: ShieldCheck,
  },
];

const userItems: MenuItem[] = [
  {
    title: "Sign in",
    url: "/auth/sign-in",
    icon: LogIn,
  },
  // Sign up is disabled - users must use invitation links to join
];

export function AppSidebar() {
  const pathname = usePathname();
  const [starCount, setStarCount] = useState<number | null>(null);
  const isAuthenticated = useIsAuthenticated();

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
      <SidebarHeader className="flex items-center flex-row justify-between">
        <div className="flex items-center gap-2 px-2 py-2">
          <Image src="/logo.png" alt="Logo" width={28} height={28} />
          <span className="text-base font-semibold">Archestra.AI</span>
        </div>
        <ColorModeToggle />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup className="px-4">
          <SidebarGroupContent>
            <SidebarMenu>
              {getNavigationItems(isAuthenticated).map((item) => (
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

        <SignedIn>
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
        </SignedIn>

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
        <DefaultCredentialsWarning />
        <SignedIn>
          <SidebarGroup className="mt-auto">
            <SidebarGroupContent>
              <UserButton
                align="center"
                className="w-full bg-transparent hover:bg-transparent text-foreground"
                localization={{ ...authLocalization, SETTINGS: "Account" }}
              />
            </SidebarGroupContent>
          </SidebarGroup>
        </SignedIn>
        <SignedOut>
          <SidebarGroupContent className="mt-4">
            <SidebarGroupLabel>User</SidebarGroupLabel>
            <SidebarMenu>
              {userItems.map((item) => (
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
        </SignedOut>
      </SidebarFooter>
    </Sidebar>
  );
}

"use client";
import {
  authLocalization,
  SignedIn,
  SignedOut,
  UserButton,
} from "@daveyplate/better-auth-ui";
import type { Role } from "@shared";
import {
  BookOpen,
  Bot,
  Bug,
  ClipboardList,
  Github,
  Info,
  LogIn,
  type LucideIcon,
  MessagesSquare,
  Router,
  Settings,
  ShieldCheck,
  Slack,
  Star,
  Wrench,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
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
import { WithRole } from "@/components/with-permission";
import { useIsAuthenticated, useRole } from "@/lib/auth.hook";
import { useGithubStars } from "@/lib/github.query";

interface MenuItem {
  title: string;
  url: string;
  icon: LucideIcon;
  subItems?: MenuItem[];
  customIsActive?: (pathname: string) => boolean;
}

const getNavigationItems = (
  isAuthenticated: boolean,
  role: Role,
): MenuItem[] => {
  return [
    {
      title: "How security works",
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
            url: "/logs/llm-proxy",
            icon: MessagesSquare,
            customIsActive: (pathname: string) => pathname.startsWith("/logs"),
          },
          {
            title: "Tools",
            url: "/tools/agents-assigned",
            icon: Wrench,
            customIsActive: (pathname: string) => pathname.startsWith("/tools"),
          },
          {
            title: "MCP Registry",
            url: "/mcp-catalog/registry",
            icon: Router,
            customIsActive: (pathname: string) =>
              pathname.startsWith("/mcp-catalog"),
          },
          ...(role === "admin"
            ? [
                {
                  title: "LLM & MCP Gateways",
                  url: "/gateways",
                  icon: Settings,
                },
              ]
            : []),
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
  const isAuthenticated = useIsAuthenticated();
  const role = useRole();
  const { data: starCount } = useGithubStars();

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
              {getNavigationItems(isAuthenticated, role).map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton
                    asChild
                    isActive={
                      item.customIsActive?.(pathname) ??
                      pathname.startsWith(item.url)
                    }
                  >
                    <Link href={item.url}>
                      <item.icon />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                  {item.subItems && (
                    <SidebarMenuSub>
                      {item.subItems.map((subItem) => (
                        <SidebarMenuSubItem key={subItem.title}>
                          <SidebarMenuSubButton
                            asChild
                            isActive={subItem.url === pathname}
                          >
                            <Link href={subItem.url}>
                              {subItem.icon && <subItem.icon />}
                              <span>{subItem.title}</span>
                            </Link>
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
          <WithRole requiredExactRole="admin">
            <SidebarGroup className="px-4">
              <SidebarGroupLabel>Security sub-agents</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {actionItems.map((item) => (
                    <SidebarMenuItem key={item.title}>
                      <SidebarMenuButton
                        asChild
                        isActive={item.url === pathname}
                      >
                        <Link href={item.url}>
                          <item.icon />
                          <span>{item.title}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </WithRole>
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
                        {starCount}
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
          <SidebarGroupContent className="mb-4">
            <SidebarGroupLabel>User</SidebarGroupLabel>
            <SidebarMenu>
              {userItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton asChild isActive={item.url === pathname}>
                    <Link href={item.url}>
                      <item.icon />
                      <span>{item.title}</span>
                    </Link>
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

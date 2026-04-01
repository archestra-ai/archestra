"use client";
import { SignedIn, UserButton } from "@daveyplate/better-auth-ui";
import {
  COMMUNITY_DOCS_URL,
  COMMUNITY_SLACK_URL,
  E2eTestId,
  GITHUB_REPO_NEW_ISSUE_URL,
  GITHUB_REPO_URL,
} from "@shared";
import { requiredPagePermissionsMap } from "@shared/access-control";
import {
  BookOpen,
  Bot,
  Bug,
  Cable,
  Database,
  Github,
  type LucideIcon,
  MessageCircle,
  MessagesSquare,
  Network,
  Route,
  Settings,
  Slack,
  Star,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import React from "react";
import { ChatSidebarSection } from "@/app/_parts/chat-sidebar-section";
import { AppLogo } from "@/components/app-logo";
import { SidebarWarningsAccordion } from "@/components/sidebar-warnings-accordion";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { useIsAuthenticated } from "@/lib/auth/auth.hook";
import { useHasPermissions, usePermissionMap } from "@/lib/auth/auth.query";
import config from "@/lib/config/config";
import { useEnterpriseFeature } from "@/lib/config/config.query";
import { useGithubStars } from "@/lib/github/github.query";
import { useAppIconLogo } from "@/lib/hooks/use-app-name";
import { cn } from "@/lib/utils";

interface NavSubItem {
  title: string;
  url: string;
  testId?: string;
  customIsActive?: (pathname: string, searchParams: URLSearchParams) => boolean;
}

interface NavItem {
  title: string;
  url: string;
  icon: LucideIcon;
  iconClassName?: string;
  testId?: string;
  customIsActive?: (pathname: string, searchParams: URLSearchParams) => boolean;
  onClick?: () => void;
  subItems?: NavSubItem[];
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

// Primary nav items shown in the header (flat list, like sidebar-10 NavMain)
const headerNavItems: NavItem[] = [
  {
    title: "New Chat",
    url: "/chat",
    icon: MessageCircle,
    customIsActive: (pathname: string) => pathname === "/chat",
  },
];

// Labeled groups shown in the scrollable content (like sidebar-10 Favorites/Workspaces)
const contentNavGroups: NavGroup[] = [
  {
    label: "Agents",
    items: [
      {
        title: "Agents",
        url: "/agents",
        icon: Bot,
        customIsActive: (pathname: string) =>
          pathname.startsWith("/agents") &&
          !pathname.startsWith("/agents/triggers"),
        subItems: [
          {
            title: "Triggers",
            url: "/agents/triggers",
            customIsActive: (pathname: string) =>
              pathname.startsWith("/agents/triggers"),
          },
        ],
      },
    ],
  },
  {
    label: "MCP & Tools",
    items: [
      {
        title: "MCPs",
        url: "/mcp/registry",
        icon: Route,
        customIsActive: (pathname: string) =>
          pathname.startsWith("/mcp/registry"),
        subItems: [
          {
            title: "Gateways",
            url: "/mcp/gateways",
            customIsActive: (pathname: string) =>
              pathname.startsWith("/mcp/gateways"),
          },
          {
            title: "Guardrails",
            url: "/mcp/tool-policies",
            testId: E2eTestId.SidebarNavGuardrails,
            customIsActive: (pathname: string) =>
              pathname.startsWith("/mcp/tool-policies"),
          },
        ],
      },
    ],
  },
  {
    label: "LLM Proxies",
    items: [
      {
        title: "LLM Proxies",
        url: "/llm/proxies",
        icon: Network,
        customIsActive: (pathname: string) => pathname === "/llm/proxies",
        subItems: [
          {
            title: "Providers",
            url: "/llm/providers/api-keys",
            customIsActive: (pathname: string) =>
              pathname.startsWith("/llm/providers"),
          },
          {
            title: "Costs & Limits",
            url: "/llm/costs",
          },
        ],
      },
    ],
  },
  {
    label: "Other",
    items: [
      {
        title: "Knowledge",
        url: "/knowledge/knowledge-bases",
        icon: Database,
        customIsActive: (pathname: string) =>
          pathname.startsWith("/knowledge") &&
          !pathname.startsWith("/knowledge/connectors"),
        subItems: [
          {
            title: "Connectors",
            url: "/knowledge/connectors",
            customIsActive: (pathname: string) =>
              pathname.startsWith("/knowledge/connectors"),
          },
        ],
      },
      {
        title: "Logs",
        url: "/llm/logs",
        icon: MessagesSquare,
        customIsActive: (pathname: string) =>
          pathname.startsWith("/llm/logs") || pathname.startsWith("/mcp/logs"),
      },
    ],
  },
];

// Primary navigation: renders all items in a single SidebarGroup/SidebarMenu
const NavPrimary = ({
  items,
  groups,
  pathname,
  searchParams,
  permissionMap,
  chatSection,
}: {
  items: NavItem[];
  groups: NavGroup[];
  pathname: string;
  searchParams: URLSearchParams;
  permissionMap: Record<string, boolean>;
  chatSection?: React.ReactNode;
}) => {
  const { isMobile, setOpenMobile } = useSidebar();

  const renderItem = (item: NavItem) => (
    <SidebarMenuItem key={item.title}>
      <SidebarMenuButton
        asChild
        tooltip={item.title}
        isActive={
          item.customIsActive?.(pathname, searchParams) ??
          pathname.startsWith(item.url)
        }
      >
        <Link
          href={item.url}
          data-testid={item.testId}
          onClick={() => {
            if (isMobile) setOpenMobile(false);
          }}
        >
          <item.icon className={item.iconClassName} />
          <span>{item.title}</span>
        </Link>
      </SidebarMenuButton>
      {item.title === "New Chat" && chatSection}
      {item.subItems && item.subItems.length > 0 && (
        <SidebarMenuSub className="mx-0 ml-3.5 px-0 pl-2.5">
          {item.subItems
            .filter((sub) => permissionMap[sub.url] ?? true)
            .map((sub) => (
              <SidebarMenuSubItem key={sub.title}>
                <SidebarMenuSubButton
                  asChild
                  isActive={
                    sub.customIsActive?.(pathname, searchParams) ??
                    pathname.startsWith(sub.url)
                  }
                >
                  <Link
                    href={sub.url}
                    data-testid={sub.testId}
                    onClick={() => {
                      if (isMobile) setOpenMobile(false);
                    }}
                  >
                    <span>{sub.title}</span>
                  </Link>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            ))}
        </SidebarMenuSub>
      )}
    </SidebarMenuItem>
  );

  const permittedHeaderItems = items.filter(
    (item) => permissionMap[item.url] ?? true,
  );

  return (
    <SidebarGroup>
      <SidebarMenu>
        {permittedHeaderItems.map(renderItem)}
        {groups.map((group) => {
          const permittedItems = group.items.filter(
            (item) => permissionMap[item.url] ?? true,
          );
          if (permittedItems.length === 0) return null;
          return (
            <React.Fragment key={group.label}>
              {permittedItems.map(renderItem)}
            </React.Fragment>
          );
        })}
      </SidebarMenu>
    </SidebarGroup>
  );
};

// Matches sidebar-10 NavSecondary: SidebarGroup with mt-auto
const NavSecondary = ({
  items,
  pathname,
  searchParams,
  permissionMap,
  starCount,
  className,
}: {
  items: NavItem[];
  pathname: string;
  searchParams: URLSearchParams;
  permissionMap: Record<string, boolean>;
  starCount: string;
  className?: string;
}) => {
  const permittedItems = items.filter(
    (item) => permissionMap[item.url] ?? true,
  );

  return (
    <SidebarGroup className={className}>
      <SidebarGroupContent>
        <SidebarMenu>
          {permittedItems.map((item) => (
            <SidebarMenuItem key={item.title}>
              <SidebarMenuButton
                asChild
                tooltip={item.title}
                isActive={
                  item.customIsActive?.(pathname, searchParams) ??
                  pathname.startsWith(item.url)
                }
              >
                <Link href={item.url}>
                  <item.icon className={item.iconClassName} />
                  <span>{item.title}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
          {!config.enterpriseFeatures.fullWhiteLabeling && (
            <>
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip="Star us on GitHub">
                  <a
                    href={GITHUB_REPO_URL}
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
                <SidebarMenuButton asChild tooltip="Documentation">
                  <a
                    href={COMMUNITY_DOCS_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <BookOpen />
                    <span>Documentation</span>
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip="Talk to developers">
                  <a
                    href={COMMUNITY_SLACK_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Slack />
                    <span>Talk to developers</span>
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip="Report a bug">
                  <a
                    href={GITHUB_REPO_NEW_ISSUE_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Bug />
                    <span>Report a bug</span>
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </>
          )}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
};

export function AppSidebar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const isAuthenticated = useIsAuthenticated();
  const { data: starCount } = useGithubStars();
  const formattedStarCount = starCount ?? "";
  const permissionMap = usePermissionMap(requiredPagePermissionsMap);
  const appIconLogo = useAppIconLogo();
  const knowledgeBaseEnabled = useEnterpriseFeature("knowledgeBase");
  // Connect page requires at least one of these (OR logic)
  const { data: canReadAgent } = useHasPermissions({ agent: ["read"] });
  const { data: canReadLlmProxy } = useHasPermissions({
    llmProxy: ["read"],
  });
  const { data: canReadMcpGateway } = useHasPermissions({
    mcpGateway: ["read"],
  });
  const showConnect = canReadAgent || canReadLlmProxy || canReadMcpGateway;

  // Filter nav groups based on enterprise features
  const filteredNavGroups = React.useMemo(() => {
    if (knowledgeBaseEnabled) return contentNavGroups;
    return contentNavGroups.map((group) => ({
      ...group,
      items: group.items.filter((item) => item.title !== "Knowledge"),
    }));
  }, [knowledgeBaseEnabled]);

  // Build additional links for UserButton popout menu
  const userMenuLinks = React.useMemo(() => {
    const links: {
      href: string;
      icon?: React.ReactNode;
      label: React.ReactNode;
      separator?: boolean;
    }[] = [];

    if (showConnect) {
      links.push({
        href: "/connection",
        icon: <Cable className="h-4 w-4" />,
        label: "Connect",
      });
    }

    links.push({
      href: "/settings/account",
      icon: <Settings className="h-4 w-4" />,
      label: "Settings",
      separator: true,
    });

    return links;
  }, [showConnect]);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="pt-4 group-data-[collapsible=icon]:pt-2 group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:gap-1">
        <div className="flex items-center justify-between group-data-[collapsible=icon]:hidden">
          <Link href="/chat">
            <AppLogo centered={false} />
          </Link>
          <SidebarTrigger className="size-7 cursor-pointer" />
        </div>
        <Link
          href="/chat"
          className="hidden group-data-[collapsible=icon]:flex"
        >
          <img src={appIconLogo} alt="Logo" className="size-7" />
        </Link>
        <SidebarTrigger className="hidden group-data-[collapsible=icon]:flex size-8 cursor-pointer" />
      </SidebarHeader>
      <SidebarContent>
        {isAuthenticated && permissionMap && (
          <>
            <NavPrimary
              items={headerNavItems}
              groups={filteredNavGroups}
              pathname={pathname}
              searchParams={searchParams}
              permissionMap={permissionMap}
              chatSection={<ChatSidebarSection />}
            />
            <NavSecondary
              items={[]}
              pathname={pathname}
              searchParams={searchParams}
              permissionMap={permissionMap}
              starCount={formattedStarCount}
              className="mt-auto"
            />
          </>
        )}
        {!isAuthenticated && !config.enterpriseFeatures.fullWhiteLabeling && (
          <NavSecondary
            items={[]}
            pathname={pathname}
            searchParams={searchParams}
            permissionMap={{}}
            starCount={formattedStarCount}
          />
        )}
      </SidebarContent>
      <SidebarFooter>
        <SidebarWarningsAccordion />
        <SignedIn>
          <SidebarGroup className="mt-auto p-0">
            <SidebarGroupContent>
              <div
                data-testid={E2eTestId.SidebarUserProfile}
                className={cn(
                  "overflow-hidden",
                  // Collapsed: hide text/chevron, show only avatar circle
                  "group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:justify-center",
                  "group-data-[collapsible=icon]:[&_button]:size-7 group-data-[collapsible=icon]:[&_button]:min-w-0 group-data-[collapsible=icon]:[&_button]:rounded-full group-data-[collapsible=icon]:[&_button]:p-0",
                  "group-data-[collapsible=icon]:[&_[data-slot=avatar]]:size-7",
                  "group-data-[collapsible=icon]:[&_[data-slot=avatar-fallback]]:text-[9px]",
                  "group-data-[collapsible=icon]:[&_button>div]:gap-0",
                  "group-data-[collapsible=icon]:[&_button>div>div:not([data-slot=avatar])]:hidden",
                  "group-data-[collapsible=icon]:[&_button>svg]:hidden",
                )}
              >
                <UserButton
                  size="default"
                  align="center"
                  side="top"
                  className="w-full bg-transparent hover:bg-transparent text-foreground"
                  disableDefaultLinks
                  additionalLinks={userMenuLinks}
                />
              </div>
            </SidebarGroupContent>
          </SidebarGroup>
        </SignedIn>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

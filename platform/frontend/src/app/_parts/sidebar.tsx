"use client";
import { SignedIn, UserButton } from "@daveyplate/better-auth-ui";
import { E2eTestId } from "@shared";
import { requiredPagePermissionsMap } from "@shared/access-control";
import {
  BookOpen,
  Bot,
  Bug,
  Cable,
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
import {
  COMMUNITY_BUG_REPORT_URL,
  COMMUNITY_DOCS_URL,
  COMMUNITY_GITHUB_URL,
  COMMUNITY_SLACK_URL,
} from "@/components/community-links";
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
  useSidebar,
} from "@/components/ui/sidebar";
import { useIsAuthenticated } from "@/lib/auth.hook";
import { usePermissionMap } from "@/lib/auth.query";
import config from "@/lib/config";
import { useGithubStars } from "@/lib/github.query";

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
    customIsActive: (pathname: string, searchParams: URLSearchParams) =>
      pathname === "/chat" && !searchParams.get("conversation"),
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
            url: "/llm/providers",
            customIsActive: (pathname: string) =>
              pathname.startsWith("/llm/providers"),
          },
          {
            title: "Cost & Limits",
            url: "/llm/cost",
          },
        ],
      },
    ],
  },
  {
    label: "Other",
    items: [
      {
        title: "Logs",
        url: "/llm/logs",
        icon: MessagesSquare,
        customIsActive: (pathname: string) =>
          pathname.startsWith("/llm/logs") || pathname.startsWith("/mcp/logs"),
      },
      {
        title: "Connect",
        url: "/connection",
        icon: Cable,
      },
      {
        title: "Settings",
        url: "/settings",
        icon: Settings,
        customIsActive: (pathname: string) => pathname.startsWith("/settings"),
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
                <SidebarMenuButton asChild>
                  <a
                    href={COMMUNITY_GITHUB_URL}
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
                <SidebarMenuButton asChild>
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
                <SidebarMenuButton asChild>
                  <a
                    href={COMMUNITY_BUG_REPORT_URL}
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

  return (
    <Sidebar>
      <SidebarHeader className="pt-4">
        <AppLogo centered={false} />
      </SidebarHeader>
      <SidebarContent>
        {isAuthenticated && permissionMap && (
          <>
            <NavPrimary
              items={headerNavItems}
              groups={contentNavGroups}
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
          <SidebarGroup className="mt-auto">
            <SidebarGroupContent>
              <div data-testid={E2eTestId.SidebarUserProfile}>
                <UserButton
                  size="default"
                  align="center"
                  className="w-full bg-transparent hover:bg-transparent text-foreground"
                  disableDefaultLinks
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

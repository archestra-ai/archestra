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
import Image from "next/image";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import React from "react";
import { ChatSidebarSection } from "@/app/_parts/chat-sidebar-section";
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
import { useOrgTheme } from "@/lib/theme.hook";

interface NavSubItem {
  title: string;
  url: string;
  customIsActive?: (pathname: string, searchParams: URLSearchParams) => boolean;
}

interface NavItem {
  title: string;
  url: string;
  icon: LucideIcon;
  iconClassName?: string;
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
        subItems: [
          {
            title: "Triggers",
            url: "/agent-triggers/ms-teams",
            customIsActive: (pathname: string) =>
              pathname.startsWith("/agent-triggers"),
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
        url: "/llm-proxies",
        icon: Network,
        customIsActive: (pathname: string) => pathname === "/llm-proxies",
        subItems: [
          {
            title: "Providers",
            url: "/llm-proxies/provider-settings",
            customIsActive: (pathname: string) =>
              pathname.startsWith("/llm-proxies/provider-settings"),
          },
          {
            title: "Cost & Limits",
            url: "/cost",
          },
        ],
      },
    ],
  },
  {
    label: "MCP & Tools",
    items: [
      {
        title: "MCP Gateways",
        url: "/mcp-gateways",
        icon: Route,
        subItems: [
          {
            title: "MCP Registry",
            url: "/mcp-catalog/registry",
            customIsActive: (pathname: string) =>
              pathname.startsWith("/mcp-catalog"),
          },
          {
            title: "Tool Policies",
            url: "/tool-policies",
            customIsActive: (pathname: string) =>
              pathname.startsWith("/tool-policies"),
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
        url: "/logs/llm-proxy",
        icon: MessagesSquare,
        customIsActive: (pathname: string) => pathname.startsWith("/logs"),
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
          {item.subItems.map((sub) => (
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
          {!config.enterpriseLicenseActivated && (
            <>
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
                    href="https://archestra.ai/docs/"
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
                    href="https://archestra.ai/join-slack"
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
  const { logo, isLoadingAppearance } = useOrgTheme() ?? {};
  const permissionMap = usePermissionMap(requiredPagePermissionsMap);

  const logoToShow = logo ? (
    <div className="flex justify-center">
      <div className="flex flex-col items-center gap-1">
        <Image
          src={logo || "/logo.png"}
          alt="Organization logo"
          width={200}
          height={60}
          className="object-contain h-12 w-auto max-w-[calc(100vw-6rem)]"
        />
        <p className="text-[10px] text-muted-foreground">
          Powered by Archestra
        </p>
      </div>
    </div>
  ) : (
    <div className="flex items-center gap-2 px-2">
      <Image
        src="/logo.png"
        alt="Logo"
        width={28}
        height={28}
        className="h-auto w-auto"
      />
      <span className="text-base font-semibold">Archestra.AI</span>
    </div>
  );

  return (
    <Sidebar>
      <SidebarHeader>
        {isLoadingAppearance ? <div className="h-[47px]" /> : logoToShow}
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
        {!isAuthenticated && !config.enterpriseLicenseActivated && (
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

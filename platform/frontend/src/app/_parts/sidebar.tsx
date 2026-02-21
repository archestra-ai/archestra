"use client";
import { SignedIn, SignedOut, UserButton } from "@daveyplate/better-auth-ui";
import { E2eTestId } from "@shared";
import { requiredPagePermissionsMap } from "@shared/access-control";
import {
  BookOpen,
  Bot,
  Bug,
  Cable,
  DollarSign,
  Github,
  History,
  Key,
  LogIn,
  type LucideIcon,
  MessageCircle,
  MessagesSquare,
  Network,
  Route,
  Router,
  Settings,
  Slack,
  Star,
  Wrench,
  Zap,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { DefaultCredentialsWarning } from "@/components/default-credentials-warning";
import { SecurityEngineWarning } from "@/components/security-engine-warning";
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
} from "@/components/ui/sidebar";
import { useIsAuthenticated } from "@/lib/auth.hook";
import { usePermissionMap } from "@/lib/auth.query";
import config from "@/lib/config";
import { useGithubStars } from "@/lib/github.query";
import { useOrgTheme } from "@/lib/theme.hook";

interface MenuItem {
  title: string;
  url: string;
  icon: LucideIcon;
  iconClassName?: string;
  customIsActive?: (pathname: string, searchParams: URLSearchParams) => boolean;
  /** If set, overrides navigation with a click handler */
  onClick?: () => void;
}

interface MenuGroup {
  label?: string;
  items: MenuItem[];
}

const getNavigationGroups = (isAuthenticated: boolean): MenuGroup[] => {
  if (!isAuthenticated) {
    return [];
  }
  return [
    {
      label: "Chat",
      items: [
        {
          title: "New Chat",
          url: "/chat",
          icon: MessageCircle,
          customIsActive: (pathname: string, searchParams: URLSearchParams) =>
            pathname === "/chat" && !searchParams.get("conversation"),
        },
        {
          title: "Recent Chats",
          url: "/chat",
          icon: History,
          onClick: () => {
            window.dispatchEvent(
              new CustomEvent("open-conversation-search", {
                detail: { recentChatsView: true },
              }),
            );
          },
          customIsActive: () => false,
        },
      ],
    },
    {
      label: "Agents",
      items: [
        {
          title: "Agents",
          url: "/agents",
          icon: Bot,
        },
        {
          title: "Agent Triggers",
          url: "/agent-triggers/ms-teams",
          icon: Zap,
          customIsActive: (pathname: string) =>
            pathname.startsWith("/agent-triggers"),
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
        },
        {
          title: "Provider Settings",
          url: "/llm-proxies/provider-settings",
          icon: Key,
          customIsActive: (pathname: string) =>
            pathname.startsWith("/llm-proxies/provider-settings"),
        },
        {
          title: "Cost & Limits",
          url: "/cost",
          icon: DollarSign,
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
        },
        {
          title: "MCP Registry",
          url: "/mcp-catalog/registry",
          icon: Router,
          customIsActive: (pathname: string) =>
            pathname.startsWith("/mcp-catalog"),
        },
        {
          title: "Tool Policies",
          url: "/tools",
          icon: Wrench,
          customIsActive: (pathname: string) => pathname.startsWith("/tools"),
        },
      ],
    },
    {
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
          customIsActive: (pathname: string) =>
            pathname.startsWith("/settings"),
        },
      ],
    },
  ];
};

const userItems: MenuItem[] = [
  {
    title: "Sign in",
    url: "/auth/sign-in",
    icon: LogIn,
  },
  // Sign up is disabled - users must use invitation links to join
];

const CommunitySideBarSection = ({ starCount }: { starCount: string }) => (
  <SidebarGroup className="px-4 py-0">
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
      </SidebarMenu>
    </SidebarGroupContent>
  </SidebarGroup>
);

const MainSideBarSection = ({
  isAuthenticated,
  pathname,
  searchParams,
  starCount,
}: {
  isAuthenticated: boolean;
  pathname: string;
  searchParams: URLSearchParams;
  starCount: string;
}) => {
  const groups = getNavigationGroups(isAuthenticated);
  const permissionMap = usePermissionMap(requiredPagePermissionsMap);

  return (
    <>
      {groups.map((group, groupIndex) => {
        const permittedItems = group.items.filter(
          (item) => permissionMap?.[item.url] ?? true,
        );
        if (permittedItems.length === 0) return null;

        return (
          <SidebarGroup
            key={group.label ?? `group-${groupIndex}`}
            className="px-4 py-1"
          >
            {group.label && (
              <SidebarGroupLabel className="text-xs text-muted-foreground uppercase tracking-wider">
                {group.label}
              </SidebarGroupLabel>
            )}
            <SidebarGroupContent>
              <SidebarMenu>
                {permittedItems.map((item) => (
                  <SidebarMenuItem key={item.title}>
                    {item.onClick ? (
                      <SidebarMenuButton
                        onClick={item.onClick}
                        isActive={false}
                      >
                        <item.icon className={item.iconClassName} />
                        <span>{item.title}</span>
                      </SidebarMenuButton>
                    ) : (
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
                    )}
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        );
      })}
      {!config.enterpriseLicenseActivated && (
        <CommunitySideBarSection starCount={starCount} />
      )}
    </>
  );
};

const FooterSideBarSection = ({ pathname }: { pathname: string }) => (
  <SidebarFooter>
    <SecurityEngineWarning />
    <DefaultCredentialsWarning />
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
);

export function AppSidebar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const isAuthenticated = useIsAuthenticated();
  const { data: starCount } = useGithubStars();
  const formattedStarCount = starCount ?? "";
  const { logo, isLoadingAppearance } = useOrgTheme() ?? {};

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
      <SidebarHeader className="flex flex-col gap-2">
        {isLoadingAppearance ? <div className="h-[47px]" /> : logoToShow}
      </SidebarHeader>
      <SidebarContent>
        {isAuthenticated ? (
          <MainSideBarSection
            isAuthenticated={isAuthenticated}
            pathname={pathname}
            searchParams={searchParams}
            starCount={formattedStarCount}
          />
        ) : (
          <CommunitySideBarSection starCount={formattedStarCount} />
        )}
      </SidebarContent>
      <FooterSideBarSection pathname={pathname} />
    </Sidebar>
  );
}

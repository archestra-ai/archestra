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
  LogIn,
  type LucideIcon,
  MessageCircle,
  MessagesSquare,
  Network,
  Router,
  Settings,
  Shield,
  Slack,
  Star,
  Wrench,
  Zap,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ChatSidebarSection } from "@/app/_parts/chat-sidebar-section";
import { DefaultCredentialsWarning } from "@/components/default-credentials-warning";
import { WithPermissions } from "@/components/roles/with-permissions";
import { SecurityEngineWarning } from "@/components/security-engine-warning";
import { Badge } from "@/components/ui/badge";
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
}

const getNavigationItems = (isAuthenticated: boolean): MenuItem[] => {
  if (!isAuthenticated) {
    return [];
  }
  return [
    {
      title: "New Chat",
      url: "/chat",
      icon: MessageCircle,
      customIsActive: (pathname: string, searchParams: URLSearchParams) =>
        pathname === "/chat" && !searchParams.get("conversation"),
    },
    {
      title: "Agents",
      url: "/agents",
      icon: Bot,
    },
    {
      title: "MCP Gateways",
      url: "/mcp-gateways",
      icon: Shield,
    },
    {
      title: "LLM Proxies",
      url: "/llm-proxies",
      icon: Network,
    },
    {
      title: "Logs",
      url: "/logs/llm-proxy",
      icon: MessagesSquare,
      customIsActive: (pathname: string) => pathname.startsWith("/logs"),
    },
    {
      title: "Tool Policies",
      url: "/tools",
      icon: Wrench,
      customIsActive: (pathname: string) => pathname.startsWith("/tools"),
    },
    {
      title: "MCP Registry",
      url: "/mcp-catalog/registry",
      icon: Router,
      customIsActive: (pathname: string) => pathname.startsWith("/mcp-catalog"),
    },
    {
      title: "Agent Triggers",
      url: "/agent-triggers/ms-teams",
      icon: Zap,
      customIsActive: (pathname: string) =>
        pathname.startsWith("/agent-triggers"),
    },
    {
      title: "Cost & Limits",
      url: "/cost",
      icon: DollarSign,
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
  const allItems = getNavigationItems(isAuthenticated);
  const permissionMap = usePermissionMap(requiredPagePermissionsMap);
  const permittedItems = allItems.filter(
    (item) => permissionMap?.[item.url] ?? true,
  );

  return (
    <>
      <SidebarGroup className="px-4">
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
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
      <WithPermissions
        permissions={{ conversation: ["read"] }}
        noPermissionHandle="tooltip"
      >
        {({ hasPermission }) => {
          return hasPermission === undefined ? null : hasPermission ? (
            <ChatSidebarSection />
          ) : (
            <SidebarGroup>
              <SidebarGroupContent>
                <Badge variant="outline" className="text-xs mx-4">
                  Recent chats are not shown
                </Badge>
              </SidebarGroupContent>
            </SidebarGroup>
          );
        }}
      </WithPermissions>
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

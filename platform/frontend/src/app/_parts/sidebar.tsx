"use client";
import { SignedIn, SignedOut, UserButton } from "@daveyplate/better-auth-ui";
import {
  BookOpen,
  Bot,
  Bug,
  DollarSign,
  Github,
  LogIn,
  type LucideIcon,
  MessageCircle,
  MessagesSquare,
  Router,
  Settings,
  Slack,
  Star,
  Wrench,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useIsAuthenticated } from "@/lib/auth.hook";
import { useGithubStars } from "@/lib/github.query";
import { useOrgTheme } from "@/lib/theme.hook";

interface MenuItem {
  title: string;
  url: string;
  icon: LucideIcon;
  subItems?: MenuItem[];
  customIsActive?: (pathname: string) => boolean;
}

const FooterCommunityLink = ({
  Icon,
  href,
  tooltipContent,
}: {
  Icon: LucideIcon;
  href: string;
  tooltipContent: React.ReactNode;
}) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-muted-foreground hover:text-foreground transition-colors"
      >
        <Icon className="h-4 w-4" />
      </a>
    </TooltipTrigger>
    <TooltipContent>{tooltipContent}</TooltipContent>
  </Tooltip>
);

const getNavigationItems = (isAuthenticated: boolean): MenuItem[] => {
  if (!isAuthenticated) {
    return [];
  }

  return [
    {
      title: "Chat",
      url: "/chat",
      icon: MessageCircle,
      customIsActive: (pathname: string) => pathname.startsWith("/chat"),
    },
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
      title: "Settings",
      url: "/settings",
      icon: Settings,
      customIsActive: (pathname: string) => pathname.startsWith("/settings"),
    },
    {
      title: "Cost & Limits",
      url: "/cost",
      icon: DollarSign,
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

export function AppSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const isAuthenticated = useIsAuthenticated();
  const { data: starCount } = useGithubStars();
  const { logo, isLoadingAppearance } = useOrgTheme() ?? {};

  const handleChatClick = (e: React.MouseEvent) => {
    e.preventDefault();
    router.push("/chat");
  };

  const logoToShow = logo ? (
    <div className="flex justify-center">
      <div className="flex flex-col items-center gap-1">
        <Image
          src={logo || "/logo.png"}
          alt="Organization logo"
          width={200}
          height={60}
          className="object-contain h-12 w-full max-w-[calc(100vw-6rem)]"
        />
        <p className="text-[10px] text-muted-foreground">
          Powered by Archestra
        </p>
      </div>
    </div>
  ) : (
    <div className="flex items-center gap-2 px-2">
      <Image src="/logo.png" alt="Logo" width={28} height={28} />
      <span className="text-base font-semibold">Archestra.AI</span>
    </div>
  );

  return (
    <Sidebar>
      <SidebarHeader className="flex flex-col gap-2">
        {isLoadingAppearance ? <div className="h-[20px]" /> : logoToShow}
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup className="px-4">
          <SidebarGroupContent>
            <SidebarMenu>
              {getNavigationItems(isAuthenticated).map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton
                    asChild={item.title !== "Chat"}
                    isActive={
                      item.customIsActive?.(pathname) ??
                      pathname.startsWith(item.url)
                    }
                    onClick={
                      item.title === "Chat" ? handleChatClick : undefined
                    }
                  >
                    {item.title === "Chat" ? (
                      <>
                        <item.icon />
                        <span>{item.title}</span>
                      </>
                    ) : (
                      <Link href={item.url}>
                        <item.icon />
                        <span>{item.title}</span>
                      </Link>
                    )}
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
      </SidebarContent>
      <SidebarFooter>
        <DefaultCredentialsWarning />
        <SignedIn>
          <SidebarGroup className="mt-auto">
            <SidebarGroupContent>
              <UserButton
                align="center"
                className="w-full bg-transparent hover:bg-transparent text-foreground"
                disableDefaultLinks
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
        <TooltipProvider>
          <div className="flex justify-center items-center gap-4">
            <FooterCommunityLink
              Icon={Github}
              href="https://github.com/archestra-ai/archestra"
              tooltipContent={
                <span className="flex items-center gap-2">
                  Star us on GitHub
                  <span className="flex items-center gap-1 text-xs">
                    <Star className="h-3 w-3" />
                    {starCount}
                  </span>
                </span>
              }
            />
            <FooterCommunityLink
              Icon={BookOpen}
              href="https://www.archestra.ai/docs/"
              tooltipContent={<p>Documentation</p>}
            />
            <FooterCommunityLink
              Icon={Slack}
              href="https://join.slack.com/t/archestracommunity/shared_invite/zt-39yk4skox-zBF1NoJ9u4t59OU8XxQChg"
              tooltipContent={<p>Talk to developers</p>}
            />
            <FooterCommunityLink
              Icon={Bug}
              href="https://github.com/archestra-ai/archestra/issues/new"
              tooltipContent={<p>Report a bug</p>}
            />
          </div>
        </TooltipProvider>
      </SidebarFooter>
    </Sidebar>
  );
}

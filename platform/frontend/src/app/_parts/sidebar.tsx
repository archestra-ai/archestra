"use client";
import {
  FileJson2,
  Info,
  MessagesSquare,
  Settings,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { Roboto_Mono } from "next/font/google";
import Image from "next/image";
import { usePathname } from "next/navigation";
import Divider from "@/components/divider";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";

const items = [
  {
    title: "How it works",
    url: "/test-agent",
    icon: Info,
    subItems: [
      {
        title: "Lethal Trifecta",
        url: "/test-agent/not-mitigated",
        icon: TriangleAlert,
      },
      {
        title: "Mitigated",
        url: "/test-agent/mitigated",
        icon: ShieldCheck,
      },
    ],
  },
  // {
  //   title: "Agents",
  //   url: "/agents",
  //   icon: Bot,
  // },
  {
    title: "Chats",
    url: "/chats",
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

const robotoMono = Roboto_Mono({
  variable: "--font-roboto-mono",
});

export function AppSidebar() {
  const pathname = usePathname();

  return (
    <Sidebar className="pr-0">
      <SidebarContent>
        <SidebarGroup>
          <div className="flex items-center gap-2 mt-2 mx-auto">
            <Image
              src="/logo-light-mode.png"
              alt="Logo"
              width={32}
              height={32}
              className="hidden dark:block"
            />
            <Image
              src="/logo-light-mode.png"
              alt="Logo"
              width={32}
              height={32}
              className="block dark:hidden"
            />
            <span className={`text-2xl font-bold ${robotoMono.className}`}>
              Archestra.AI
            </span>
          </div>
          <Divider className="my-4" />
          <SidebarGroupContent>
            <SidebarMenu className="gap-2">
              {items.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton asChild isActive={item.url === pathname}>
                    <a href={item.url} className="text-xl">
                      <item.icon />
                      <span className="text-base">{item.title}</span>
                    </a>
                  </SidebarMenuButton>
                  {item.subItems && (
                    <SidebarMenuSub>
                      {item.subItems.map((subItem) => (
                        <SidebarMenuSubItem key={subItem.title}>
                          <SidebarMenuButton
                            asChild
                            isActive={subItem.url === pathname}
                          >
                            <a href={subItem.url} className="text-xl">
                              {subItem.icon && <subItem.icon />}
                              <span className="text-base">{subItem.title}</span>
                            </a>
                          </SidebarMenuButton>
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
    </Sidebar>
  );
}

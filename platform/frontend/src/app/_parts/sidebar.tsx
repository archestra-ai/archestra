"use client";
import { FileJson2, History, Settings, ShieldCheck } from "lucide-react";
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
} from "@/components/ui/sidebar";

const items = [
  {
    title: "Test Agent",
    url: "/test-agent",
    icon: ShieldCheck,
  },
  {
    title: "Tool Mapping",
    url: "/tool-mapping",
    icon: FileJson2,
  },
  {
    title: "History",
    url: "/history",
    icon: History,
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
    <Sidebar variant="floating">
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
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}

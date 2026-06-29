"use client";

import { useEffect, useState } from "react";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";

const SKELETON_REVEAL_DELAY_MS = 500;
const SKELETON_ROW_WIDTHS = ["w-3/4", "w-full", "w-5/6"];

export function ChatListSkeleton({ subClass }: { subClass: string }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), SKELETON_REVEAL_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  if (!visible) {
    return null;
  }

  return (
    <SidebarGroup className="pt-0">
      <SidebarGroupLabel>Recents</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuSub className={subClass}>
              {SKELETON_ROW_WIDTHS.map((width) => (
                <SidebarMenuSubItem key={width}>
                  <div className="flex w-full items-center justify-between gap-1">
                    <div className="flex h-8 w-full flex-1 items-center gap-2 rounded-md p-2">
                      <Skeleton
                        className={`h-4 ${width} bg-sidebar-foreground/5`}
                      />
                    </div>
                  </div>
                </SidebarMenuSubItem>
              ))}
            </SidebarMenuSub>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

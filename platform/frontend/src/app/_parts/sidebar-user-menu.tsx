"use client";

import { ChevronsUpDown, LogOut, Settings } from "lucide-react";
import Link from "next/link";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSession } from "@/lib/auth/auth.query";

/**
 * Sidebar footer user menu: avatar + name/email trigger with Settings and
 * Sign Out actions. Renders nothing until a session exists.
 *
 * The trigger markup (button > div > Avatar + text, chevron as direct svg
 * child) is load-bearing: the collapsed-sidebar styles in sidebar.tsx target
 * it via [data-slot=avatar] and child-position selectors.
 */
export function SidebarUserMenu() {
  const { data: session } = useSession();
  const user = session?.user;

  if (!user) return null;

  const displayName = user.name || user.email;
  const initials = displayName.slice(0, 2).toUpperCase();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="lg"
          className="h-auto w-full justify-between bg-transparent p-2 has-[>svg]:px-2 hover:bg-transparent text-foreground focus-visible:border-transparent focus-visible:ring-sidebar-ring focus-visible:ring-2"
        >
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Avatar className="size-8 rounded-full">
              {user.image && <AvatarImage src={user.image} alt={displayName} />}
              <AvatarFallback className="text-xs">{initials}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1 text-left leading-tight">
              <div className="truncate text-sm font-medium">{displayName}</div>
              {user.name && (
                <div className="truncate text-xs text-muted-foreground">
                  {user.email}
                </div>
              )}
            </div>
          </div>
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="center"
        side="top"
        className="min-w-56"
        // Closing via an outside click otherwise returns focus to the trigger,
        // which re-shows its focus ring and reads as a stray border. Keep focus
        // off the trigger on pointer-driven close (keyboard Tab still rings it).
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <DropdownMenuLabel className="font-normal">
          <div className="truncate text-sm font-medium">{displayName}</div>
          {user.name && (
            <div className="truncate text-xs font-normal text-muted-foreground">
              {user.email}
            </div>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/settings/account">
            <Settings className="size-4" />
            Settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/auth/sign-out">
            <LogOut className="size-4" />
            Sign Out
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

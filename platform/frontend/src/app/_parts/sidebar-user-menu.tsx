"use client";

import {
  ChevronsUpDown,
  LogOut,
  Monitor,
  Moon,
  Settings,
  Sun,
} from "lucide-react";
import Link from "next/link";
import { useTheme } from "next-themes";
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
import { cn } from "@/lib/utils";

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
  const { theme, setTheme } = useTheme();
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
        // Keeps the menu off the viewport edge when the collapsed-rail
        // trigger sits in the bottom-left corner.
        collisionPadding={8}
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
        <div className="flex gap-1 px-2 py-1.5">
          {themeOptions.map(({ value, label, Icon }) => (
            <Button
              key={value}
              variant="ghost"
              size="icon-sm"
              className={cn(
                "flex-1 text-muted-foreground",
                theme === value && "bg-accent text-accent-foreground",
              )}
              aria-label={label}
              aria-pressed={theme === value}
              title={label}
              onClick={() => setTheme(value)}
            >
              <Icon className="size-4" />
            </Button>
          ))}
        </div>
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

const themeOptions = [
  { value: "system", label: "System", Icon: Monitor },
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
] as const;

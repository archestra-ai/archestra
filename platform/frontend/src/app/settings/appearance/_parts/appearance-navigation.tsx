"use client";

import { MessageSquare, PanelTop, Type } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SectionSubnavLink } from "@/components/section-nav";
import { cn } from "@/lib/utils/tailwind";
import { APPEARANCE_PAGES } from "./appearance-pages";

export function AppearanceSubnav() {
  const pathname = usePathname();
  return (
    <div className="flex flex-col gap-0.5 pb-1">
      {APPEARANCE_PAGES.map((page, index) => {
        const Icon = ICONS[index];
        return (
          <SectionSubnavLink
            key={page.id}
            href={`/settings/appearance/${page.id}`}
            active={
              pathname.endsWith(`/${page.id}`) ||
              (page.id === "branding" && pathname === "/settings/appearance")
            }
            icon={<Icon className="size-4" />}
            label={page.label}
          />
        );
      })}
    </div>
  );
}

export function AppearancePagesRow() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Appearance pages"
      className="flex flex-wrap gap-1 lg:hidden"
    >
      {APPEARANCE_PAGES.map((page) => {
        const active =
          pathname.endsWith(`/${page.id}`) ||
          (page.id === "branding" && pathname === "/settings/appearance");
        return (
          <Link
            key={page.id}
            href={`/settings/appearance/${page.id}`}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-md px-2 py-1.5 text-xs transition-colors",
              active
                ? "bg-accent font-medium text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/50",
            )}
          >
            {page.label}
          </Link>
        );
      })}
    </nav>
  );
}

const ICONS = [Type, MessageSquare, PanelTop];

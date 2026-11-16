"use client";

import { Container, SlidersHorizontal } from "lucide-react";
import { usePathname } from "next/navigation";
import { SectionSubnavLink } from "@/components/section-nav";
import { Badge } from "@/components/ui/badge";

/** The Agents settings pages, under its entry in the settings list. */
export function AgentsSubnav() {
  const pathname = usePathname();
  return (
    <div className="flex flex-col gap-0.5 pb-1">
      {AGENTS_PAGES.map(({ href, label, Icon, beta }) => (
        <SectionSubnavLink
          key={href}
          href={href}
          active={pathname === href}
          icon={<Icon className="size-4" />}
          label={label}
          badge={
            beta && (
              <Badge
                variant="outline"
                className="border-transparent bg-sidebar-chip px-1.5 py-0 text-[10px] text-sidebar-emphasis dark:border-sidebar-emphasis dark:bg-sidebar"
              >
                Beta
              </Badge>
            )
          }
        />
      ))}
    </div>
  );
}

const AGENTS_PAGES = [
  {
    href: "/settings/agents",
    label: "General",
    Icon: SlidersHorizontal,
    beta: false,
  },
  {
    href: "/settings/agents/runtimes",
    label: "Runtimes",
    Icon: Container,
    beta: true,
  },
] as const;

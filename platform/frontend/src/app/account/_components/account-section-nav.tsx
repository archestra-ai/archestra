"use client";

import { usePathname } from "next/navigation";
import { accountSections } from "@/app/account/_components/account-sections";
import { useAccountConnections } from "@/app/account/_components/use-account-connections";
import { SectionNav } from "@/components/section-nav";

/**
 * Section switcher for the account pages. Each entry is a real route, so the
 * active one is read off the pathname rather than tracked in state.
 */
export function AccountSectionNav() {
  const pathname = usePathname();
  const { isApplicable, isError } = useAccountConnections();
  const visibleSections = accountSections.filter(
    (section) =>
      section.id !== "connections" || isApplicable === true || isError,
  );

  // Longest match wins: every href starts with "/account", so a plain
  // `startsWith` would light up Profile on every section.
  const activeHref =
    visibleSections
      .map(({ href }) => href)
      .filter((href) => pathname === href || pathname.startsWith(`${href}/`))
      .sort((a, b) => b.length - a.length)[0] ?? "/account";

  return (
    <SectionNav
      label="Personal settings sections"
      activeHref={activeHref}
      items={visibleSections.map(({ href, label, Icon }) => ({
        href,
        label,
        Icon,
      }))}
    />
  );
}

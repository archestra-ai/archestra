"use client";

import {
  type AccountSectionId,
  accountSections,
} from "@/app/account/_components/account-sections";
import { SectionNav } from "@/components/section-nav";

/**
 * Section switcher for the account page. Each entry is a real link to
 * `?section=<id>` so sections are deep-linkable and survive back/forward; the
 * link deliberately drops any other query params, so a `?highlight=` deep link
 * doesn't re-fire its dialog once the reader moves to another section.
 */
export function AccountSectionNav({
  activeSection,
}: {
  activeSection: AccountSectionId;
}) {
  return (
    <SectionNav
      label="Personal settings sections"
      activeHref={`/account?section=${activeSection}`}
      items={accountSections.map(({ id, label, Icon }) => ({
        href: `/account?section=${id}`,
        label,
        Icon,
      }))}
    />
  );
}

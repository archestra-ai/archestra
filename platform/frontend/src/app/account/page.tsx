"use client";

import { AccessSection } from "@/app/account/_components/access-section";
import { ConnectionsSection } from "@/app/account/_components/connections-section";
import { ProfileSection } from "@/app/account/_components/profile-section";
import { PublicLinksSection } from "@/app/account/_components/public-links-section";
import { SecuritySection } from "@/app/account/_components/security-section";
import { SettingsSectionGroup } from "@/components/settings-section";

/**
 * The Account tab: one page, ruled into sections the way agent and MCP detail
 * pages are — who you are, what you have access to, how you sign in, what
 * your agents may use on your behalf, and what they published for you. Every section's content is the same
 * bordered list of rows, so the page reads as one surface.
 */
export default function AccountProfilePage() {
  return (
    <SettingsSectionGroup className="max-w-5xl">
      <ProfileSection />
      <AccessSection />
      <SecuritySection />
      <ConnectionsSection />
      <PublicLinksSection />
    </SettingsSectionGroup>
  );
}

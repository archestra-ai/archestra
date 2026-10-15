"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { AccessSection } from "@/app/account/_components/access-section";
import { ProfileSection } from "@/app/account/_components/profile-section";
import { SecuritySection } from "@/app/account/_components/security-section";
import { SettingsSectionGroup } from "@/components/settings-section";

/**
 * The Account tab: one page, ruled into sections the way agent and MCP detail
 * pages are — who you are, what you have access to, and how you sign in.
 * Every section's content is the same bordered list of rows, so the page
 * reads as one surface.
 */
export default function AccountProfilePage() {
  const router = useRouter();

  // Credentials used to be a section here at `/account#credentials`. Old
  // links, and GitHub sign-ins started before the move, still arrive there,
  // on a fresh load or as a hash change while this tab is open.
  useEffect(() => {
    const forwardOldCredentialsLink = () => {
      if (window.location.hash === "#credentials") {
        router.replace(`/account/credentials${window.location.search}`);
      }
    };
    forwardOldCredentialsLink();
    window.addEventListener("hashchange", forwardOldCredentialsLink);
    return () =>
      window.removeEventListener("hashchange", forwardOldCredentialsLink);
  }, [router]);

  return (
    <SettingsSectionGroup className="max-w-5xl">
      <ProfileSection />
      <AccessSection />
      <SecuritySection />
    </SettingsSectionGroup>
  );
}

"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { AccessSection } from "@/app/account/_components/access-section";
import { resolveLegacyAccountHref } from "@/app/account/_components/account-sections";
import { ConnectionsSection } from "@/app/account/_components/connections-section";
import { ProfileSection } from "@/app/account/_components/profile-section";
import { SecuritySection } from "@/app/account/_components/security-section";
import { SettingsSectionGroup } from "@/components/settings-section";

/**
 * The Profile tab, and the landing spot for the `/account?section=…` URLs that
 * predate the tab routes. Those are bookmarked and printed in docs, so they are
 * redirected rather than broken; anything else just renders Profile.
 *
 * One page, ruled into sections the way agent and MCP detail pages are: who
 * you are, what you have access to, how you sign in, and what your agents
 * may use on your behalf. Every section's
 * content is the same bordered list of rows, so the page reads as one surface.
 */
export default function AccountProfilePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const legacyHref = resolveLegacyAccountHref(searchParams.get("section"));
  const redirectTo =
    legacyHref && legacyHref !== "/account" ? legacyHref : null;

  useEffect(() => {
    if (!redirectTo) return;
    // `replace`, not `push`: the old URL should not sit in the back stack
    // waiting to redirect again.
    router.replace(`${redirectTo}?${searchParams.toString()}`);
  }, [redirectTo, router, searchParams]);

  if (redirectTo) return null;

  return (
    <SettingsSectionGroup className="max-w-5xl">
      <ProfileSection />
      <AccessSection />
      <SecuritySection />
      <ConnectionsSection />
    </SettingsSectionGroup>
  );
}

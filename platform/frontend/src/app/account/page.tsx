"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { resolveLegacyAccountHref } from "@/app/account/_components/account-sections";
import { MyTeamsCard } from "@/app/account/_components/my-teams-card";
import { ProfileCard } from "@/components/settings/profile-card";
import { SettingsSectionStack } from "@/components/settings/settings-block";

/**
 * The Profile section, and the landing spot for the `/account?section=…` URLs
 * that predate these routes. Those are bookmarked and printed in docs, so they
 * are redirected rather than broken; anything else just renders Profile.
 *
 * My Teams sits directly below the profile fields here rather than in its own
 * route: it is a short, read-only list every user wants beside the rest of
 * their personal details, not a section worth a separate page.
 */
export default function AccountProfilePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const legacyHref = resolveLegacyAccountHref({
    section: searchParams.get("section"),
    highlight: searchParams.get("highlight"),
  });

  useEffect(() => {
    if (!legacyHref || legacyHref === "/account") return;
    // `replace`, not `push`: the old URL should not sit in the back stack
    // waiting to redirect again.
    router.replace(`${legacyHref}?${searchParams.toString()}`);
  }, [legacyHref, router, searchParams]);

  if (legacyHref && legacyHref !== "/account") return null;

  return (
    <SettingsSectionStack className="space-y-5">
      <ProfileCard />
      <MyTeamsCard />
    </SettingsSectionStack>
  );
}

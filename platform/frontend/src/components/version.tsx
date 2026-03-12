"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { usePublicAppearance } from "@/lib/appearance.query";
import { useLatestGitHubRelease } from "@/lib/github-release.query";
import { useHealth } from "@/lib/health.query";
import { useOrganization } from "@/lib/organization.query";
import { hasNewerVersion } from "@/lib/version-utils";

interface VersionProps {
  inline?: boolean;
}

export function Version({ inline = false }: VersionProps) {
  const { data } = useHealth();
  const { data: latestRelease } = useLatestGitHubRelease();
  const { data: organization } = useOrganization();
  const { data: appearance } = usePublicAppearance();
  const pathname = usePathname();
  const [shouldHide, setShouldHide] = useState(false);

  const isSettingsPage = pathname.startsWith("/settings");
  const isChatPage = pathname.startsWith("/chat");
  // Prefer authenticated org data; fall back to public appearance for unauthenticated pages (e.g. sign-in)
  const footerText = organization?.footerText ?? appearance?.footerText;

  const hasNewVersion = useMemo(() => {
    if (!data?.version || !latestRelease?.tag_name) return false;
    return hasNewerVersion(data.version, latestRelease.tag_name);
  }, [data?.version, latestRelease?.tag_name]);

  useEffect(() => {
    // Only check for hide-version class if not inline
    if (inline) return;

    // Check if the hide-version class is present on body
    const checkHideClass = () => {
      setShouldHide(document.body.classList.contains("hide-version"));
    };

    // Initial check
    checkHideClass();

    // Listen for class changes
    const observer = new MutationObserver(checkHideClass);
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["class"],
    });

    return () => observer.disconnect();
  }, [inline]);

  if (!inline && shouldHide) {
    return null;
  }

  // Show custom footer text when set and NOT on settings pages
  if (footerText && !isSettingsPage) {
    return (
      <div
        className={
          inline
            ? "text-xs text-muted-foreground"
            : "text-xs text-muted-foreground text-center py-4"
        }
      >
        {footerText}
      </div>
    );
  }

  // Hide version on chat pages when no custom footer text is set
  if (isChatPage) {
    return null;
  }

  return (
    <>
      {data?.version && (
        <div
          className={
            inline
              ? "text-xs text-muted-foreground"
              : "text-xs text-muted-foreground text-center py-4"
          }
        >
          Version: {data.version}
          {hasNewVersion && latestRelease && (
            <>
              , new:{" "}
              <Link
                href={latestRelease.html_url}
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-foreground transition-colors"
              >
                {latestRelease.tag_name.replace(/^platform-/, "")}
              </Link>
            </>
          )}
        </div>
      )}
    </>
  );
}

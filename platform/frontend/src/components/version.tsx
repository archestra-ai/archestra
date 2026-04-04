"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import config from "@/lib/config/config";
import { useHealth } from "@/lib/config/health.query";
import { useLatestGitHubRelease } from "@/lib/github/github-release.query";
import {
  useAppearanceSettings,
  useOrganization,
} from "@/lib/organization.query";
import { hasNewerVersion } from "@/lib/utils/version";

interface VersionProps {
  inline?: boolean;
}

export function Version({ inline = false }: VersionProps) {
  const { data } = useHealth();
  const { data: latestRelease } = useLatestGitHubRelease();
  const { data: organization } = useOrganization();
  const { data: appearance } = useAppearanceSettings();
  const [shouldHide, setShouldHide] = useState(false);

  // Prefer authenticated org data; fall back to public appearance for unauthenticated pages (e.g. sign-in)
  const footerText = organization?.footerText ?? appearance?.footerText;
  const version = data?.version;
  const hideReleaseLink = config.enterpriseFeatures.fullWhiteLabeling;

  const hasNewVersion = useMemo(() => {
    if (!version || !latestRelease?.tag_name) return false;
    return hasNewerVersion(version, latestRelease.tag_name);
  }, [version, latestRelease?.tag_name]);

  const footerString = useMemo(() => {
    // Wait for version to load before rendering to avoid layout shift
    if (!version) return null;
    if (footerText) return `${footerText} (v${version})`;
    return `Version: ${version}`;
  }, [footerText, version]);

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

  if (!footerString) {
    return null;
  }

  const className = inline
    ? "text-xs text-muted-foreground"
    : "text-xs text-muted-foreground text-center py-4";

  // Custom footer text: show text with version, no upgrade link
  if (footerText) {
    return <div className={className}>{footerString}</div>;
  }

  // Default: show version with optional upgrade link
  return (
    <div className={className}>
      {footerString}
      {!hideReleaseLink && hasNewVersion && latestRelease && (
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
  );
}

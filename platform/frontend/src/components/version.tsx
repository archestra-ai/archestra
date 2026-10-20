// This file contains Enterprise regions licensed under LICENSE_ENTERPRISE.
"use client";

import Link from "next/link";
import { memo, type ReactNode, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useSession } from "@/lib/auth/auth.query";
import config from "@/lib/config/config";
import { useConfig } from "@/lib/config/config.query";
import { useHealth } from "@/lib/config/health.query";
import { useLatestGitHubRelease } from "@/lib/github/github-release.query";
import {
  useAppearanceSettings,
  useOrganization,
} from "@/lib/organization.query";

interface VersionProps {
  inline?: boolean;
}

/**
 * Set on `<body>` while a sticky wizard footer is on screen. The footer holds
 * an element carrying {@link VERSION_SLOT_ATTRIBUTE}, and the page's version
 * line renders there instead, so it stays with the footer rather than
 * scrolling away underneath it.
 */
export const VERSION_IN_FOOTER_CLASS = "version-in-footer";
export const VERSION_SLOT_ATTRIBUTE = "data-version-slot";
export const VERSION_SLOT_GENERATION_ATTRIBUTE = "data-version-slot-generation";

export const Version = memo(function Version({ inline = false }: VersionProps) {
  // Signed in, the version comes with the config the shell already loads;
  // `/health` is only asked on signed-out pages (e.g. sign-in), once the
  // session check says so: a signed-in page load never asks it.
  const { data: session, isPending: isSessionPending } = useSession();
  const isAuthenticated = session?.user != null;
  const { data: appConfig } = useConfig();
  const { data: health } = useHealth({
    enabled: !isSessionPending && !isAuthenticated,
  });
  const { data: organization } = useOrganization();
  const { data: appearance } = useAppearanceSettings();
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  const hideReleaseLink = config.enterpriseFeatures.fullWhiteLabeling;
  // SPDX-SnippetEnd
  // Prefer authenticated org data; fall back to public appearance for unauthenticated pages (e.g. sign-in)
  const footerText = organization?.footerText ?? appearance?.footerText;
  const version = isAuthenticated ? appConfig?.version : health?.version;
  // Dev and staging builds report a full 40-char commit SHA; seven is enough
  // to identify it, and the full value stays in the hover title.
  const displayVersion =
    version && /^[0-9a-f]{40}$/i.test(version) ? version.slice(0, 7) : version;
  // The release check only powers a footer hint, so skip it when hidden and
  // defer it when visible to keep startup focused on app data.
  const { data: latestRelease } = useLatestGitHubRelease({
    enabled: !hideReleaseLink && !!version && !footerText,
    deferMs: 5000,
  });
  const [shouldHide, setShouldHide] = useState(false);
  const [footerSlot, setFooterSlot] = useState<Element | null>(null);

  // The comparison needs semver, which loads only once there is a release to
  // compare against (it is not part of the first load).
  const [hasNewVersion, setHasNewVersion] = useState(false);
  const latestTag = latestRelease?.tag_name;
  useEffect(() => {
    if (!version || !latestTag) {
      setHasNewVersion(false);
      return;
    }
    let cancelled = false;
    void import("@/lib/utils/version").then(({ hasNewerVersion }) => {
      if (!cancelled) setHasNewVersion(hasNewerVersion(version, latestTag));
    });
    return () => {
      cancelled = true;
    };
  }, [version, latestTag]);

  const footerString = useMemo(() => {
    // Wait for version to load before rendering to avoid layout shift
    if (!version) return null;
    if (footerText) return `${footerText} (v${displayVersion})`;
    return `Version: ${displayVersion}`;
  }, [footerText, version, displayVersion]);

  useEffect(() => {
    // Only check for hide-version class if not inline
    if (inline) return;

    // Check if the hide-version class is present on body
    const checkHideClass = () => {
      setShouldHide(document.body.classList.contains("hide-version"));
      setFooterSlot(
        document.body.classList.contains(VERSION_IN_FOOTER_CLASS)
          ? document.querySelector(`[${VERSION_SLOT_ATTRIBUTE}]`)
          : null,
      );
    };

    // Initial check
    checkHideClass();

    // Listen for class changes
    const observer = new MutationObserver(checkHideClass);
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["class", VERSION_SLOT_GENERATION_ATTRIBUTE],
    });

    return () => observer.disconnect();
  }, [inline]);

  if (!inline && shouldHide) {
    return null;
  }
  // In a footer slot it sits under the footer's buttons, which already pad.
  const place = (node: ReactNode) =>
    !inline && footerSlot ? createPortal(node, footerSlot) : node;

  if (!footerString) {
    // Keep the footer's slot open while /health resolves. As a block footer it
    // sits under content that centres in the remaining space, so appearing
    // late would shift that content — including the auth surface's loading
    // indicator — up by half this height.
    return inline || footerSlot ? null : (
      <div aria-hidden="true" className="py-4 text-[11px]">
        &nbsp;
      </div>
    );
  }

  const className = inline
    ? "text-xs text-muted-foreground"
    : footerSlot
      ? "text-[11px] leading-none tabular-nums text-muted-foreground"
      : "text-[11px] tabular-nums text-muted-foreground text-center py-4";

  // Custom footer text: show text with version, no upgrade link
  if (footerText) {
    return place(
      <div className={className} title={version}>
        {footerString}
      </div>,
    );
  }

  // Default: show version with optional upgrade link
  return place(
    <div className={className} title={version}>
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
    </div>,
  );
});

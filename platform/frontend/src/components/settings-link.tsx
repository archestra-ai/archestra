"use client";

import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { isSettingsAreaPath } from "@/app/_parts/settings-navigation";
import { useCredentialsPage } from "@/app/_parts/use-credentials-page";
import { useSettingsAreaAccess } from "@/app/_parts/use-settings-area-access";

/**
 * A link that may point into Settings. For a reader who cannot see the
 * Settings area it would only bounce them to Personal Settings, so it renders
 * `fallback` instead — by default its own text, unlinked. Links outside
 * Settings always render.
 */
export function SettingsLink({
  fallback,
  children,
  ...props
}: ComponentProps<typeof Link> & { fallback?: ReactNode }) {
  const canSeeSettings = useSettingsAreaAccess();
  const href = typeof props.href === "string" ? props.href : "";
  // Hrefs may carry a query, e.g. `?permissions=all`.
  if (isSettingsAreaPath(href.split(/[?#]/, 1)[0])) {
    if (canSeeSettings !== true) {
      return fallback !== undefined ? fallback : <span>{children}</span>;
    }
  }
  return <Link {...props}>{children}</Link>;
}

/**
 * Where "the Credentials page" is for this reader ({@link useCredentialsPage}):
 * Settings → Credentials when they can open it, otherwise Personal Settings.
 * Until permissions load it points at Personal Settings, which forwards a
 * reader who has Settings → Credentials.
 */
export function useCredentialsPageHref(): string {
  return useCredentialsPage()?.href ?? "/account/credentials";
}

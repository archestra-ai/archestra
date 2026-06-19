"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ComponentProps } from "react";

/**
 * Sidebar links opt out of Next.js viewport prefetch to avoid fetching every
 * visible sidebar route's RSC payload when the app shell mounts. Hover/focus
 * prefetch keeps intentional navigation fast without competing with initial
 * page API requests.
 */
export function SidebarPrefetchLink({
  href,
  onFocus,
  onMouseEnter,
  ...props
}: ComponentProps<typeof Link>) {
  const router = useRouter();

  return (
    <Link
      href={href}
      prefetch={false}
      onFocus={(event) => {
        const prefetchHref = getPrefetchHref(href);
        if (prefetchHref) router.prefetch(prefetchHref);
        onFocus?.(event);
      }}
      onMouseEnter={(event) => {
        const prefetchHref = getPrefetchHref(href);
        if (prefetchHref) router.prefetch(prefetchHref);
        onMouseEnter?.(event);
      }}
      {...props}
    />
  );
}

/**
 * Converts a Next.js Link href into the string URL required by router.prefetch.
 * Sidebar links currently pass strings, but this keeps manual prefetch safe if
 * a future item uses a UrlObject with query or hash fields.
 */
function getPrefetchHref(href: ComponentProps<typeof Link>["href"]) {
  if (typeof href === "string") return href;
  if (!href.pathname) return null;

  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(href.query ?? {})) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item != null) searchParams.append(key, String(item));
      }
      continue;
    }
    if (value != null) searchParams.set(key, String(value));
  }

  const query = searchParams.toString();
  return `${href.pathname}${query ? `?${query}` : ""}${href.hash ?? ""}`;
}

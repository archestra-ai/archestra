"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ComponentProps } from "react";

type LinkHref = ComponentProps<typeof Link>["href"];

/**
 * A link that prefetches its route on hover, focus or touch instead of when
 * it scrolls into view. Use it where many links are visible at once, such as a
 * sidebar or a table of rows, so mounting the page does not fetch every
 * linked route's RSC payload alongside the page's own API requests.
 */
export function IntentPrefetchLink({
  href,
  onFocus,
  onMouseEnter,
  onTouchStart,
  onPrefetch,
  ...props
}: Omit<ComponentProps<typeof Link>, "prefetch"> & {
  /** Runs after the route prefetch, with the same URL. */
  onPrefetch?: (href: string) => void;
}) {
  const router = useRouter();

  const prefetch = () => {
    const prefetchHref = getPrefetchHref(href);
    if (!prefetchHref) return;
    router.prefetch(prefetchHref);
    onPrefetch?.(prefetchHref);
  };

  return (
    <Link
      href={href}
      prefetch={false}
      onFocus={(event) => {
        prefetch();
        onFocus?.(event);
      }}
      onMouseEnter={(event) => {
        prefetch();
        onMouseEnter?.(event);
      }}
      onTouchStart={(event) => {
        prefetch();
        onTouchStart?.(event);
      }}
      {...props}
    />
  );
}

/**
 * Converts a Next.js Link href into the string URL required by router.prefetch,
 * including the query and hash of a UrlObject.
 */
function getPrefetchHref(href: LinkHref) {
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

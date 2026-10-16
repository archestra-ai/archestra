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

  // The spread comes first so that these props always win over it.
  return (
    <Link
      {...props}
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
    />
  );
}

/**
 * Converts a Next.js Link href into the string URL required by router.prefetch,
 * including the search or query and the hash of a UrlObject. Returns null for
 * anything but an app path: a link to another site (`https:`, `mailto:`,
 * `//host`), a hash-only or a relative href.
 */
function getPrefetchHref(href: LinkHref) {
  if (typeof href === "string") return isAppPath(href) ? href : null;
  if (href.protocol || href.host || href.hostname) return null;
  if (!href.pathname || !isAppPath(href.pathname)) return null;

  // As in Next's own URL formatting, `search` wins over `query`.
  let search = href.search ?? "";
  if (!search) {
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
    search = searchParams.toString();
  }
  const hash = href.hash ?? "";

  return [
    href.pathname,
    search && !search.startsWith("?") ? `?${search}` : search,
    hash && !hash.startsWith("#") ? `#${hash}` : hash,
  ].join("");
}

function isAppPath(path: string) {
  return path.startsWith("/") && !path.startsWith("//");
}

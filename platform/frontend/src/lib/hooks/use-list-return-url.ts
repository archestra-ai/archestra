"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * Remembers the query string every pathname is visited with in this tab, so
 * `PageBackLink` (and anything else built on `useListReturnHref`) can restore
 * a list page's filters instead of always landing on its bare URL. Mounted
 * once near the root layout.
 *
 * Keyed per exact pathname (not a shared blob) so an unrelated page can never
 * pick up another page's filters, and a filtered visit followed by a
 * filters-cleared visit to the same list correctly overwrites the earlier
 * entry rather than leaking it forward.
 */
export function ListReturnUrlTracker() {
  const pathname = usePathname();
  const queryString = useSearchParams().toString();

  useEffect(() => {
    try {
      window.sessionStorage.setItem(
        `${STORAGE_PREFIX}${pathname}`,
        queryString,
      );
    } catch {
      // Back links just fall back to their plain href when storage is
      // unavailable (quota exceeded, private browsing, etc).
    }
  }, [pathname, queryString]);

  return null;
}

/**
 * Resolves a "Back to <list>" href to the query string that pathname was
 * last visited with in this tab, e.g. "/agents" -> "/agents?search=foo".
 * Falls back to `href` unchanged when that pathname was never visited this
 * session (a direct/deep link straight into the detail page) or when `href`
 * already carries its own query string.
 */
export function useListReturnHref(href: string): string {
  const [resolvedHref, setResolvedHref] = useState(href);

  useEffect(() => {
    if (href.includes("?")) {
      setResolvedHref(href);
      return;
    }
    let queryString: string | null = null;
    try {
      queryString = window.sessionStorage.getItem(`${STORAGE_PREFIX}${href}`);
    } catch {
      // Fall back to the plain href below.
    }
    setResolvedHref(queryString ? `${href}?${queryString}` : href);
  }, [href]);

  return resolvedHref;
}

const STORAGE_PREFIX = "archestra.list-return:";

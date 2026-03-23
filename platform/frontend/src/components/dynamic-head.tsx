"use client";

import { DEFAULT_APP_DESCRIPTION, DEFAULT_APP_FULL_NAME } from "@shared";
import { useEffect } from "react";
import { useAppearanceSettings } from "@/lib/organization.query";

/**
 * Client component that dynamically updates document title, favicon, and OG tags
 * based on the organization's appearance settings.
 */
export function DynamicHead() {
  const { data: appearance, isFetched } = useAppearanceSettings();

  // Update document title only after data has loaded to avoid flashing default
  useEffect(() => {
    if (!isFetched) return;
    document.title = appearance?.appName || DEFAULT_APP_FULL_NAME;
  }, [appearance?.appName, isFetched]);

  // Update favicon only after data has loaded to avoid flashing default
  useEffect(() => {
    if (!isFetched) return;

    const link = document.querySelector(
      'link[rel="icon"]',
    ) as HTMLLinkElement | null;

    const href = appearance?.favicon || "/favicon.ico";

    if (link) {
      link.href = href;
    } else {
      const newLink = document.createElement("link");
      newLink.rel = "icon";
      newLink.href = href;
      document.head.appendChild(newLink);
    }
  }, [appearance?.favicon, isFetched]);

  // Update meta description, OG description, and OG title
  useEffect(() => {
    const description = appearance?.ogDescription || DEFAULT_APP_DESCRIPTION;
    const title = appearance?.appName || DEFAULT_APP_FULL_NAME;

    upsertMeta("name", "description", description);
    upsertMeta("property", "og:description", description);
    upsertMeta("property", "og:title", title);
  }, [appearance?.ogDescription, appearance?.appName]);

  return null;
}

function upsertMeta(attr: "name" | "property", value: string, content: string) {
  let el = document.querySelector(
    `meta[${attr}="${value}"]`,
  ) as HTMLMetaElement | null;
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, value);
    document.head.appendChild(el);
  }
  el.content = content;
}

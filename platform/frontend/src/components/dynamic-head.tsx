"use client";

import { useEffect } from "react";
import { usePublicAppearance } from "@/lib/appearance.query";

/**
 * Client component that dynamically updates document title, favicon, and OG tags
 * based on the organization's appearance settings.
 */
export function DynamicHead() {
  const { data: appearance, isFetched } = usePublicAppearance();

  // Update document title only after data has loaded to avoid flashing default
  useEffect(() => {
    if (!isFetched) return;
    document.title = appearance?.appName || "Archestra.AI";
  }, [appearance?.appName, isFetched]);

  // Update favicon
  useEffect(() => {
    const link = document.querySelector(
      'link[rel="icon"]',
    ) as HTMLLinkElement | null;

    if (!appearance?.favicon) {
      if (link) link.href = "/favicon.ico";
      return;
    }

    if (link) {
      link.href = appearance.favicon;
    } else {
      const newLink = document.createElement("link");
      newLink.rel = "icon";
      newLink.href = appearance.favicon;
      document.head.appendChild(newLink);
      return () => {
        newLink.remove();
      };
    }
  }, [appearance?.favicon]);

  // Update meta description, OG description, and OG title
  useEffect(() => {
    const description =
      appearance?.ogDescription || "Enterprise MCP Platform for AI Agents";
    const title = appearance?.appName || "Archestra.AI";

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

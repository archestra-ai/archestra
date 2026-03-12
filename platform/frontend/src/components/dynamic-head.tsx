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
    if (!appearance?.favicon) return;

    let link = document.querySelector(
      'link[rel="icon"]',
    ) as HTMLLinkElement | null;
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.href = appearance.favicon;
  }, [appearance?.favicon]);

  // Update meta description and OG tags
  useEffect(() => {
    const description =
      appearance?.ogDescription || "Enterprise MCP Platform for AI Agents";

    let metaDesc = document.querySelector(
      'meta[name="description"]',
    ) as HTMLMetaElement | null;
    if (!metaDesc) {
      metaDesc = document.createElement("meta");
      metaDesc.name = "description";
      document.head.appendChild(metaDesc);
    }
    metaDesc.content = description;

    let ogDesc = document.querySelector(
      'meta[property="og:description"]',
    ) as HTMLMetaElement | null;
    if (!ogDesc) {
      ogDesc = document.createElement("meta");
      ogDesc.setAttribute("property", "og:description");
      document.head.appendChild(ogDesc);
    }
    ogDesc.content = description;
  }, [appearance?.ogDescription]);

  return null;
}

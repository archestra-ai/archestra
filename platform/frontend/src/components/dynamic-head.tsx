"use client";

import {
  DEFAULT_APP_DESCRIPTION,
  DEFAULT_APP_FULL_NAME,
} from "@archestra/shared";
import { useEffect } from "react";
import { useAppearanceSettings } from "@/lib/organization.query";

const DEFAULT_FAVICON_PATH = "/default-favicon.ico";
const DEFAULT_FAVICON_VERSION = "default";
const FAVICON_PATH = "/favicon.ico";
const PNG_DATA_URI_PREFIX = "data:image/png;base64,";

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

  // The server-rendered layout already contains the current content-versioned
  // favicon. Avoid replacing that stable candidate when the same appearance
  // query hydrates; this effect remains responsible for live settings changes.
  useEffect(() => {
    if (!isFetched) return;

    let cancelled = false;
    void updateFavicon(appearance?.favicon ?? null, () => cancelled);
    return () => {
      cancelled = true;
    };
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

async function updateFavicon(
  favicon: string | null,
  isCancelled: () => boolean,
) {
  const isCustom = favicon?.startsWith(PNG_DATA_URI_PREFIX) ?? false;
  let version = DEFAULT_FAVICON_VERSION;
  let href = DEFAULT_FAVICON_PATH;
  if (isCustom && favicon) {
    try {
      version = await getFaviconVersion(favicon);
      href = `${FAVICON_PATH}?v=${version}`;
    } catch {
      // Still apply the latest appearance if Web Crypto is unavailable in this
      // user agent; data URLs do not depend on a route or cache implementation.
      version = "custom";
      href = favicon;
    }
  }
  if (isCancelled()) return;

  let link = document.querySelector(
    'link[rel="icon"]',
  ) as HTMLLinkElement | null;
  if (link?.dataset.faviconVersion === version) return;

  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.href = href;
  link.dataset.faviconVersion = version;
}

async function getFaviconVersion(favicon: string) {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(favicon),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  )
    .join("")
    .slice(0, 16);
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

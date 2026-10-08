"use client";

import { useEffect, useState } from "react";

/**
 * Docs screenshot mode: the docs screenshot capture sets this cookie so every
 * instance renders the same clean shell regardless of its license, seeded
 * state, or admin credentials — no community links, no sidebar warnings, no
 * onboarding dots. Display-only; it changes no data or permissions.
 */
export const DOCS_SCREENSHOT_COOKIE = "archestra_docs_screenshot";

export function useDocsScreenshotMode(): boolean {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    setEnabled(
      document.cookie
        .split(";")
        .some((part) => part.trim() === `${DOCS_SCREENSHOT_COOKIE}=1`),
    );
  }, []);

  return enabled;
}

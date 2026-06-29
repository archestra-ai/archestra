"use client";

import { useEffect } from "react";

/**
 * Minimal layout for browser preview popup window.
 * Hides the sidebar and shows only the browser preview content.
 */
export default function BrowserPreviewLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Add class to body to hide sidebar in popup
  useEffect(() => {
    document.body.classList.add("browser-preview-popup");
    return () => {
      document.body.classList.remove("browser-preview-popup");
    };
  }, []);

  return <>{children}</>;
}

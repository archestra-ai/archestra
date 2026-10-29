"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  parseSidebarOpen,
  rememberSidebarOpenCookie,
  SIDEBAR_COOKIE_NAME,
} from "@/lib/sidebar-state";

/** The cookie seeds SSR and hydration; local storage preserves older choices. */
export function useSidebarOpenState(initialOpen: boolean | null) {
  const [choice, setChoice] = useState<boolean | null>(null);
  const remembered = useSyncExternalStore(
    subscribeToStorage,
    readRememberedSidebarOpen,
    () => initialOpen,
  );
  const open = choice ?? remembered;

  useEffect(() => {
    if (open !== null) rememberSidebarOpenCookie(open);
  }, [open]);

  const setOpen = useCallback((next: boolean) => {
    setChoice(next);
    rememberSidebarOpenCookie(next);
    try {
      window.localStorage.setItem(SIDEBAR_OPEN_STORAGE_KEY, String(next));
    } catch {
      // The cookie and in-memory choice still work without local storage.
    }
  }, []);

  return [open, setOpen] as const;
}

const SIDEBAR_OPEN_STORAGE_KEY = "archestra-sidebar-open";

function readRememberedSidebarOpen(): boolean {
  try {
    // Prefer the same value the server saw, including a cookie-only browser.
    const cookie = document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${SIDEBAR_COOKIE_NAME}=`));
    const open = parseSidebarOpen(
      cookie?.slice(SIDEBAR_COOKIE_NAME.length + 1),
    );
    if (open !== null) return open;
  } catch {
    // Fall back to the older local-storage preference if cookies are blocked.
  }
  try {
    return (
      parseSidebarOpen(window.localStorage.getItem(SIDEBAR_OPEN_STORAGE_KEY)) ??
      true
    );
  } catch {
    return true;
  }
}

function subscribeToStorage(onChange: () => void) {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

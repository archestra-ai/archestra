"use client";

import { useMemo } from "react";

interface PlatformInfo {
  isMac: boolean;
  modKey: "Cmd" | "Ctrl";
  altKey: "Opt" | "Alt";
  modSymbol: "⌘" | "Ctrl";
  altSymbol: "⌥" | "Alt";
}

export function usePlatform(): PlatformInfo {
  return useMemo(() => {
    const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
    return {
      isMac,
      modKey: isMac ? "Cmd" : "Ctrl",
      altKey: isMac ? "Opt" : "Alt",
      modSymbol: isMac ? "⌘" : "Ctrl",
      altSymbol: isMac ? "⌥" : "Alt",
    };
  }, []);
}

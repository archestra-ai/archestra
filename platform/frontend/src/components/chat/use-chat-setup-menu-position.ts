"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getChatSetupMenuPosition } from "./chat-setup-menu-position";

/** Measure before opening so tab height changes cannot flip the picker. */
export function useChatSetupMenuPosition(open: boolean) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState<
    ReturnType<typeof getChatSetupMenuPosition>
  >({ side: "bottom", maxHeight: 360 });
  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const viewport = window.visualViewport;
    setPosition(
      getChatSetupMenuPosition({
        triggerTop: rect.top,
        triggerBottom: rect.bottom,
        viewportTop: viewport?.offsetTop ?? 0,
        viewportHeight: viewport?.height ?? window.innerHeight,
      }),
    );
  }, []);
  useEffect(() => {
    if (!open) return;
    const viewport = window.visualViewport;
    window.addEventListener("resize", updatePosition);
    viewport?.addEventListener("resize", updatePosition);
    viewport?.addEventListener("scroll", updatePosition);
    return () => {
      window.removeEventListener("resize", updatePosition);
      viewport?.removeEventListener("resize", updatePosition);
      viewport?.removeEventListener("scroll", updatePosition);
    };
  }, [open, updatePosition]);
  return { triggerRef, position, updatePosition };
}

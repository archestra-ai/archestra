"use client";

import { useEffect } from "react";

// iOS Safari never resizes the layout viewport when the on-screen keyboard
// opens — it only shrinks the *visual* viewport and pans the page to reveal
// the focused input, which drags the whole viewport-locked app shell up and
// down. Publishing the visual viewport height as a CSS variable lets the
// shell size itself to the actually-visible area (see the h-app-viewport
// utility in globals.css), and re-pinning the window scroll cancels Safari's
// pan so the chrome stays put and only the intended inner regions scroll.
export function VisualViewportHeight() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const update = () => {
      // Pinch zoom also shrinks the visual viewport; resizing the layout to
      // the zoomed-in area would reflow the page, so only track scale 1 and
      // never fight the user's pan while zoomed.
      if (viewport.scale !== 1) return;
      document.documentElement.style.setProperty(
        "--visual-viewport-height",
        `${viewport.height}px`,
      );
      // Only counter Safari's focus pan while the keyboard is actually
      // shrinking the visual viewport well below the layout viewport.
      // Re-pinning outside that state fights iOS's elastic overscroll
      // spring-back, which reads as the whole UI flickering after a drag.
      const keyboardOpen =
        viewport.height < document.documentElement.clientHeight - 100;
      if (keyboardOpen && window.scrollY !== 0) window.scrollTo(0, 0);
    };

    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      document.documentElement.style.removeProperty("--visual-viewport-height");
    };
  }, []);

  return null;
}

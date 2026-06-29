"use client";

import { useEffect, useState } from "react";

/**
 * SortingHatMonologue — displays the Sorting Hat's internal deliberation
 * when it decides which Hogwarts house a tool belongs to.
 *
 * The monologue appears above the chat input as a transient, auto-dismissing
 * banner styled to evoke Hogwarts parchment and fades away after 10 seconds.
 */
export function SortingHatMonologue({ monologue }: { monologue: string }) {
  const [visible, setVisible] = useState(false);
  const [displayedMonologue, setDisplayedMonologue] = useState("");
  const [fadeOut, setFadeOut] = useState(false);

  useEffect(() => {
    if (!monologue) return;

    // Show the new monologue
    setDisplayedMonologue(monologue);
    setVisible(true);
    setFadeOut(false);

    // Auto-dismiss after 10 seconds
    const fadeTimer = setTimeout(() => {
      setFadeOut(true);
    }, 9000);

    const hideTimer = setTimeout(() => {
      setVisible(false);
    }, 10000);

    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(hideTimer);
    };
  }, [monologue]);

  if (!visible || !displayedMonologue) return null;

  return (
    <div
      className={`
        transition-all duration-1000 ease-in-out
        ${fadeOut ? "opacity-0 -translate-y-2" : "opacity-100 translate-y-0"}
        mb-2 mx-auto max-w-4xl px-4
      `}
      aria-live="polite"
    >
      <div
        className="
          relative rounded-lg border border-amber-500/30 bg-amber-950/20
          px-4 py-3 text-sm text-amber-200/90
          backdrop-blur-sm shadow-sm
          dark:bg-amber-950/30 dark:border-amber-500/25
        "
      >
        {/* Wizard hat icon */}
        <span
          className="mr-2 text-amber-400 select-none"
          aria-hidden="true"
          role="img"
        >
          🎩
        </span>
        <span className="italic">{displayedMonologue}</span>
        <button
          type="button"
          onClick={() => {
            setFadeOut(true);
            setTimeout(() => setVisible(false), 500);
          }}
          className="
            absolute right-2 top-1/2 -translate-y-1/2
            text-amber-400/60 hover:text-amber-300/90
            transition-colors text-xs px-1 py-0.5 rounded
          "
          aria-label="Dismiss Sorting Hat message"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

"use client";

import { AlertTriangle, Loader2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { DialogStickyFooter } from "@/components/ui/dialog";

/**
 * Inline confirm surface that replaces the host form's footer when a
 * save would cascade-reinstall installed servers — avoids modal stacking.
 *
 * `mode` mirrors the backend cascade path: "manual" sets
 * `reinstallRequired: true` (servers stay on old config until the user
 * clicks Reinstall on each); "auto" fires a background reinstall now
 * (pods briefly restart). Title, body, and CTA all align to the path.
 */
export function ReinstallConfirmBar({
  mode,
  isMultitenant = false,
  affectedServerCount,
  isSubmitting,
  onCancel,
  onConfirm,
}: {
  mode: "manual" | "auto";
  isMultitenant?: boolean;
  affectedServerCount: number;
  isSubmitting: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  // If Save was clicked while scrolled mid-form, the new footer would
  // sit off-screen — user would read it as "nothing happened".
  const barRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    barRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, []);

  // Esc cancels, Enter confirms. Listen on `window` in capture phase so
  // we fire BEFORE Radix's document-level Esc handler — otherwise Esc
  // would also close the host dialog (losing the user's form work).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape" && e.key !== "Enter") return;
      e.stopImmediatePropagation();
      e.preventDefault();
      // Block actions while saving — no double-fire, no late cancel.
      if (isSubmitting) return;
      if (e.key === "Escape") {
        onCancel();
      } else {
        void onConfirm();
      }
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () =>
      window.removeEventListener("keydown", handler, { capture: true });
  }, [isSubmitting, onCancel, onConfirm]);

  const isPlural = !isMultitenant && affectedServerCount > 1;
  const installNoun = `install${isPlural ? "s" : ""}`;

  const title =
    mode === "manual"
      ? isMultitenant
        ? "Save change — shared deployment will need a Reinstall"
        : `Save change — ${affectedServerCount} ${installNoun} will need a Reinstall`
      : isMultitenant
        ? "Restart the shared deployment now?"
        : `Restart ${affectedServerCount} ${installNoun} now?`;

  const confirmLabel = mode === "manual" ? "Save change" : "Save and restart";

  const body =
    mode === "manual" ? (
      isMultitenant ? (
        <>
          Your change needs a new value. The deployment keeps running on the old
          config until someone clicks <strong>Reinstall</strong> and provides
          the value.
        </>
      ) : (
        <>
          Your change needs a new value. The {installNoun}{" "}
          {isPlural ? "keep" : "keeps"} running on the old config until someone
          clicks <strong>Reinstall</strong>
          {isPlural ? " on each" : ""} and provides the value.
        </>
      )
    ) : (
      <>
        {isPlural ? "Each will" : "It'll"} briefly go offline, then come back on
        the new config. You don't need to do anything else.
      </>
    );

  return (
    <DialogStickyFooter
      ref={barRef}
      className="flex-col items-stretch gap-3 border-t-2 border-amber-500/40 bg-amber-50/40 dark:bg-amber-950/20 sm:flex-col"
    >
      <div className="flex items-start gap-3 pr-2 text-sm">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-500" />
        <div className="flex-1 space-y-1 text-foreground/90">
          <div className="font-semibold text-foreground">{title}</div>
          <div>{body}</div>
        </div>
      </div>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={isSubmitting}
        >
          Cancel
        </Button>
        <Button
          type="button"
          onClick={() => onConfirm()}
          disabled={isSubmitting}
        >
          {isSubmitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Saving…
            </>
          ) : (
            confirmLabel
          )}
        </Button>
      </div>
    </DialogStickyFooter>
  );
}

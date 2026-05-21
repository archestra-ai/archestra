"use client";

import { AlertTriangle, Loader2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { DialogStickyFooter } from "@/components/ui/dialog";
import type { usePresetEntityName } from "@/lib/organization.query";

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
  presetCount,
  presetEntityName,
  isSubmitting,
  onCancel,
  onConfirm,
}: {
  mode: "manual" | "auto";
  isMultitenant?: boolean;
  affectedServerCount: number;
  presetCount: number;
  presetEntityName: ReturnType<typeof usePresetEntityName>;
  isSubmitting: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  const totalPresetCount = presetCount + 1;
  const presetNoun =
    totalPresetCount === 1
      ? presetEntityName.singular.toLowerCase()
      : presetEntityName.plural.toLowerCase();

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

  const title =
    mode === "manual" ? "Reinstall required" : "Servers will reinstall";

  const confirmLabel =
    mode === "manual" ? "Save and mark for reinstall" : "Save and reinstall";

  const subjectText = isMultitenant ? (
    <>The shared deployment</>
  ) : (
    <>
      <strong>{affectedServerCount}</strong>{" "}
      {affectedServerCount === 1 ? "install" : "installs"}
      {/* "across N" only makes sense with >1 install — a single
          install only lives in one place, suffix would mislead. */}
      {presetCount > 0 && affectedServerCount > 1 ? (
        <>
          {" "}
          across <strong>{totalPresetCount}</strong> {presetNoun}
        </>
      ) : null}
    </>
  );

  const isPlural = !isMultitenant && affectedServerCount > 1;
  const pronoun = isPlural ? "They" : "It";
  const possessive = isPlural ? "their" : "its";
  const eachSuffix = isPlural ? " on each" : "";

  const body =
    mode === "manual" ? (
      <>
        {subjectText} will be marked for reinstall. {pronoun} keep
        {isPlural ? "" : "s"} running on {possessive} current configuration
        until you click <strong>Reinstall</strong>
        {eachSuffix}.
      </>
    ) : (
      <>
        {subjectText} will reinstall now. {pronoun} may briefly restart or
        become unavailable.
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

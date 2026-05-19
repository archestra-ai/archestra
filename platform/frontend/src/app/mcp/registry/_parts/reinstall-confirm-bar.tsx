"use client";

import { AlertTriangle, Loader2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { DialogStickyFooter } from "@/components/ui/dialog";
import type { usePresetEntityName } from "@/lib/organization.query";

/**
 * Inline confirmation surface that replaces a form/dialog footer when a
 * save would cascade-reinstall installed servers. Same surface as the
 * host dialog (no modal stacking), preserves spatial context with the
 * Save button the user just clicked.
 *
 * `mode` matches the backend cascade path that will actually fire:
 *   "manual" → `reinstallRequired: true` is set, servers keep running on
 *              the old config until the user clicks Reinstall on each;
 *   "auto"   → `setImmediate` background reinstall fires, pods restart
 *              and may briefly be unavailable.
 *
 * The title, body, and button label all align to the chosen path so the
 * user can't be misled by a CTA that says "reinstall" while the copy
 * says "flag for reinstall" (or vice versa).
 *
 * Used by both `mcp-catalog-form.tsx` (parent / standalone catalog
 * editing) and `preset-editor-dialog.tsx` (preset value editing).
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

  // Pull the bar into view on appear. If the user clicked Save while
  // scrolled mid-form, the footer transformation can otherwise sit
  // off-screen — they'd see "nothing happened" instead of the warning.
  const barRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    barRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, []);

  // Keyboard shortcuts: Esc cancels, Enter confirms. Register on
  // `window` (not `document`) in the capture phase: capture order is
  // window → document → … → target, so a window-capture listener fires
  // BEFORE Radix's dialog-level Esc handler (which is on document in
  // capture). Combined with `stopImmediatePropagation` this guarantees
  // Esc cancels the bar without also closing the host dialog. Enter
  // is suppressed while submitting to prevent double-fire on slow
  // saves.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape" && e.key !== "Enter") return;
      // Always block both keys from propagating while the bar is up —
      // otherwise Radix's dialog Esc handler closes the host dialog
      // (losing the user's form work) and a stray Enter would re-fire
      // the form's submit. During a save we additionally suppress the
      // action itself so the user can't double-fire or cancel a save
      // that's already past the point of no return.
      e.stopImmediatePropagation();
      e.preventDefault();
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
      {/*
       * The "across N envs" suffix only makes sense when the install
       * count > 1 AND the cascade actually spans multiple envs.
       * Showing it for a single install is misleading — the install
       * can only be in one place, so "across 2 environments" reads
       * like the install spans both when it doesn't.
       */}
      {presetCount > 0 && affectedServerCount > 1 ? (
        <>
          {" "}
          across <strong>{totalPresetCount}</strong> {presetNoun}
        </>
      ) : null}
    </>
  );

  // Grammar-match the pronoun and "on each" suffix to the subject. The
  // multitenant subject is always singular ("The shared deployment");
  // the per-server subject is singular when count===1, plural otherwise.
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

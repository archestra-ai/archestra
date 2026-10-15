"use client";

import { AlertTriangle, Loader2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { DialogStickyFooter } from "@/components/ui/dialog";
import {
  InlineNotice,
  InlineNoticeBody,
  InlineNoticeText,
} from "@/components/ui/inline-notice";
import { WizardFooter } from "@/components/wizard-footer";
import { cn } from "@/lib/utils/tailwind";

/**
 * Confirm surface that replaces the host form's footer when a save would
 * cascade-reinstall installed servers — avoids modal stacking. It keeps the
 * host's own footer (`WizardFooter` on a page, `DialogStickyFooter` in a
 * dialog) and its button row, and states the consequence in the shared
 * warning notice above the buttons.
 *
 * `mode` mirrors the backend cascade path: "manual" sets
 * `reinstallRequired: true` (servers stay on old config until the user
 * clicks Reinstall on each); "auto" fires a background reinstall now
 * (pods briefly restart); "rename" is a pure DB cascade (tools renamed
 * in place, nothing restarts — but connected MCP clients must reload
 * their tool list). Title, body, and CTA all align to the path.
 */
export function ReinstallConfirmBar({
  mode,
  renamed = false,
  newName,
  isMultitenant = false,
  affectedServerCount,
  isSubmitting,
  onCancel,
  onConfirm,
  layout = "dialog",
  className,
}: {
  mode: "manual" | "auto" | "rename";
  /** A name change rides along with a manual/auto cascade — append the
   *  MCP-client tool-list reload warning to that mode's body. */
  renamed?: boolean;
  /** The new catalog name, for concrete `<newname>__…` tool-prefix copy. */
  newName?: string;
  isMultitenant?: boolean;
  affectedServerCount: number;
  isSubmitting: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
  /** Which footer the host form uses: a full-page wizard or a dialog. */
  layout?: "page" | "dialog";
  className?: string;
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

  // Same per-character sanitization as ToolModel.slugifyName's prefix, so
  // the copy shows the exact prefix the renamed tools will carry.
  const toolPrefix = newName
    ?.toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_-]/g, "");

  const title =
    mode === "rename"
      ? "Rename server — connected MCP clients must reload"
      : mode === "manual"
        ? isMultitenant
          ? "Save change — shared deployment will need a Reinstall"
          : `Save change — ${affectedServerCount} ${installNoun} will need a Reinstall`
        : isMultitenant
          ? "Restart the shared deployment now?"
          : `Restart ${affectedServerCount} ${installNoun} now?`;

  const confirmLabel =
    mode === "rename"
      ? "Save and rename"
      : mode === "manual"
        ? "Save change"
        : "Save and restart";

  const clientReloadWarning = (
    <>
      Connected MCP clients must reload their tool list, or calls using the old
      tool names will fail.
    </>
  );

  const body =
    mode === "rename" ? (
      <>
        Tools become <strong>{toolPrefix || "the new name"}__…</strong>{" "}
        immediately; no server restarts. {clientReloadWarning}
      </>
    ) : mode === "manual" ? (
      // Manual mode covers both a plain runtime-config edit on a
      // single-tenant server and a change that needs a new value, so the
      // copy must not assume there is a value to provide.
      isMultitenant ? (
        <>
          The deployment keeps running on the old config until someone clicks{" "}
          <strong>Reinstall</strong>, which asks for any new values the change
          needs.
        </>
      ) : (
        <>
          The {installNoun} {isPlural ? "keep" : "keeps"} running on the old
          config until someone clicks <strong>Reinstall</strong>
          {isPlural ? <span>{" on each"}</span> : null}
          <span>{", which asks for any new values the change needs."}</span>
        </>
      )
    ) : (
      <>
        {isPlural ? "Each will" : "It'll"} briefly go offline, then come back on
        the new config. You don't need to do anything else.
      </>
    );

  // A rename composed with a manual/auto cascade still renames every tool.
  const renameNote =
    renamed && mode !== "rename" ? (
      <>
        {" "}
        Tools are also renamed
        {toolPrefix ? (
          <>
            {" "}
            to <strong>{toolPrefix}__…</strong>
          </>
        ) : null}
        . {clientReloadWarning}
      </>
    ) : null;

  // The ref sits on the notice: it is the part of the bar that must be read
  // before confirming, and `WizardFooter` does not forward a ref.
  const notice = (
    <InlineNotice ref={barRef} variant="warning">
      <AlertTriangle />
      <InlineNoticeBody>
        <span className="font-medium">{title}</span>
        <InlineNoticeText>
          {body}
          {renameNote}
        </InlineNoticeText>
      </InlineNoticeBody>
    </InlineNotice>
  );

  const cancelButton = (
    <Button
      type="button"
      variant="outline"
      size={layout === "page" ? "sm" : "default"}
      onClick={onCancel}
      disabled={isSubmitting}
    >
      Cancel
    </Button>
  );
  const confirmButton = (
    <Button
      type="button"
      size={layout === "page" ? "sm" : "default"}
      onClick={() => onConfirm()}
      disabled={isSubmitting}
    >
      {isSubmitting ? (
        <>
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Saving…</span>
        </>
      ) : (
        <span>{confirmLabel}</span>
      )}
    </Button>
  );

  if (layout === "page") {
    return (
      <WizardFooter notice={notice} className={className}>
        {cancelButton}
        {confirmButton}
      </WizardFooter>
    );
  }

  return (
    <DialogStickyFooter
      className={cn("flex-col items-stretch gap-3 sm:flex-col", className)}
    >
      {notice}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {cancelButton}
        {confirmButton}
      </div>
    </DialogStickyFooter>
  );
}

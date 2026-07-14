"use client";

import { Check, Copy, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * Obviously-fake token used in "copy with placeholder" output, so a pasted
 * command fails loudly instead of looking like it carries a real credential.
 */
export const SECRET_PLACEHOLDER_TOKEN = "archestra_TOKEN";

/**
 * Copy control for code that embeds a secret. Instead of a single copy icon
 * that silently resolves the real token, it offers two explicitly labeled
 * actions: "Copy with real token" and "Copy with placeholder" — so putting a
 * secret on the clipboard is always a visible choice.
 *
 * When `getSecretText` is null (no resolvable token for this viewer), it
 * degrades to a plain copy button for the placeholder text.
 */
export function SecretCopyButton({
  getSecretText,
  placeholderText,
  variant = "default",
  disabled = false,
  onBusyChange,
}: {
  /**
   * Resolve the full clipboard text with the real secret substituted in.
   * Return null to abort (e.g. the token fetch failed and already toasted).
   * Pass null when the viewer has no resolvable secret at all.
   */
  getSecretText: (() => Promise<string | null>) | null;
  /** Full clipboard text with the placeholder in place of the secret. */
  placeholderText: string;
  /** "terminal" matches the dark code-card controls on the connection page. */
  variant?: "default" | "terminal";
  /** Lock the control while an adjacent action (e.g. a reveal fetch) runs. */
  disabled?: boolean;
  /** Mirrors the in-flight state so callers can lock adjacent controls. */
  onBusyChange?: (busy: boolean) => void;
}) {
  const [isCopying, setIsCopying] = useState(false);
  const [copied, setCopied] = useState(false);

  const flashCopied = () => {
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleCopyPlaceholder = async () => {
    if (disabled) return;
    try {
      await navigator.clipboard.writeText(placeholderText);
      flashCopied();
      toast.success("Copied with placeholder token");
    } catch {
      toast.error("Failed to copy");
    }
  };

  const handleCopySecret = async () => {
    if (!getSecretText || isCopying || disabled) return;
    setIsCopying(true);
    onBusyChange?.(true);
    try {
      const text = await getSecretText();
      // The fetch failed and already surfaced an error; don't copy the mask
      // under a success toast.
      if (text === null) return;
      await navigator.clipboard.writeText(text);
      flashCopied();
      toast.success("Copied with real token");
    } catch {
      toast.error("Failed to copy");
    } finally {
      setIsCopying(false);
      onBusyChange?.(false);
    }
  };

  const icon = isCopying ? (
    <Loader2 className="size-4 animate-spin" />
  ) : copied ? (
    <Check
      className={cn(
        "size-4",
        variant === "terminal" ? "text-[#4ade80]" : "text-green-500",
      )}
    />
  ) : (
    <Copy className="size-4" />
  );

  const trigger =
    variant === "terminal" ? (
      <button
        type="button"
        disabled={isCopying || disabled}
        aria-label="Copy"
        className="flex size-7 items-center justify-center rounded border border-[#1f2937] bg-[#0d1117] text-[#9ca3af] transition-colors hover:text-white disabled:opacity-50"
      >
        {icon}
      </button>
    ) : (
      <Button
        variant="ghost"
        size="icon"
        aria-label="Copy"
        disabled={isCopying || disabled}
      >
        {icon}
      </Button>
    );

  if (!getSecretText) {
    // No secret to offer — a plain copy of the placeholder needs no menu.
    return variant === "terminal" ? (
      <button
        type="button"
        onClick={handleCopyPlaceholder}
        disabled={disabled}
        aria-label="Copy"
        className="flex size-7 items-center justify-center rounded border border-[#1f2937] bg-[#0d1117] text-[#9ca3af] transition-colors hover:text-white disabled:opacity-50"
      >
        {icon}
      </button>
    ) : (
      <Button
        variant="ghost"
        size="icon"
        aria-label="Copy"
        disabled={disabled}
        onClick={handleCopyPlaceholder}
      >
        {icon}
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={handleCopySecret}>
          Copy with real token
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleCopyPlaceholder}>
          Copy with placeholder
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

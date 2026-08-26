"use client";

import { CHANNEL_INSTRUCTIONS_MAX_LENGTH } from "@archestra/shared";
import { useEffect, useState } from "react";
import { StandardFormDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const PLACEHOLDER =
  "e.g. Every message in this channel is a task — create it immediately and don't ask for confirmation.";

/**
 * Editor for a channel's free-text instructions.
 *
 * The instructions are handed to the agent with every message this channel
 * routes to it, on top of the agent's own instructions, so the same agent can
 * behave differently per channel.
 */
export function ChannelInstructionsDialog({
  open,
  onOpenChange,
  channelLabel,
  agentName,
  instructions,
  isSaving,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channelLabel: string;
  /** The agent these instructions apply on top of, when one is assigned. */
  agentName?: string | null;
  instructions: string | null;
  isSaving: boolean;
  /** Receives the trimmed text, or null when the field was cleared. */
  onSave: (instructions: string | null) => void;
}) {
  const [value, setValue] = useState(instructions ?? "");

  // Re-seed from the stored value each time the dialog opens, so reopening
  // after a cancel shows what is saved rather than the abandoned edit.
  useEffect(() => {
    if (open) setValue(instructions ?? "");
  }, [open, instructions]);

  const overLimit = value.length > CHANNEL_INSTRUCTIONS_MAX_LENGTH;
  const isDirty = value.trim() !== (instructions ?? "").trim();

  return (
    <StandardFormDialog
      open={open}
      onOpenChange={onOpenChange}
      isDirty={isDirty}
      title={`Instructions for ${channelLabel}`}
      description={
        agentName ? (
          <span>
            Delivered to <strong>{agentName}</strong> with every message in this
            channel, on top of the agent&apos;s own instructions. Where the two
            conflict, these win — so one agent can behave differently per
            channel.
          </span>
        ) : (
          <span>
            Delivered to this channel&apos;s agent with every message, on top of
            the agent&apos;s own instructions. Where the two conflict, these win
            — so one agent can behave differently per channel. Assign an agent
            to this channel for them to take effect.
          </span>
        )
      }
      onSubmit={() => {
        if (overLimit) return;
        onSave(value.trim() || null);
      }}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={isSaving || overLimit}>
            <span>Save</span>
          </Button>
        </>
      }
    >
      <Textarea
        autoFocus
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={PLACEHOLDER}
        aria-label="Channel instructions"
        aria-invalid={overLimit}
        // field-sizing-content grows the textarea with what is typed; the cap
        // keeps the character counter — the only explanation for a disabled
        // Save — on screen instead of pushing it below the fold.
        className="min-h-48 max-h-[45vh] overflow-y-auto"
      />
      <div className="mt-2 flex items-center justify-between gap-4 text-xs">
        <span className="text-muted-foreground">
          Leave empty to remove the instructions for this channel.
        </span>
        <span
          className={cn(
            "shrink-0 tabular-nums",
            overLimit ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {value.length} / {CHANNEL_INSTRUCTIONS_MAX_LENGTH}
        </span>
      </div>
    </StandardFormDialog>
  );
}

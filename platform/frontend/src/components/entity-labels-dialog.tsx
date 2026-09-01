"use client";

import { useEffect, useRef, useState } from "react";
import {
  type ProfileLabel,
  ProfileLabels,
  type ProfileLabelsRef,
} from "@/components/agent-labels";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogStickyFooter,
  DialogTitle,
} from "@/components/ui/dialog";

interface EntityLabelsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The row being labelled, named in the dialog's subtitle. */
  entityName: string;
  /** The row's current labels; re-seeded every time the dialog opens. */
  labels: ProfileLabel[];
  /** Persists the edited set. Rejecting leaves the dialog open. */
  onSave: (labels: ProfileLabel[]) => Promise<unknown>;
}

/**
 * Edit one row's labels from a list page.
 *
 * Most labelled entities are created through a dialog or a page that has no
 * room for a label editor, and several (models, OAuth clients, knowledge
 * files) cannot be created from the UI at all — so a row-level editor, rather
 * than a field on each create form, is what actually makes labels assignable
 * everywhere. Pages that *do* have a natural create form keep theirs too.
 */
export function EntityLabelsDialog({
  open,
  onOpenChange,
  entityName,
  labels,
  onSave,
}: EntityLabelsDialogProps) {
  const [draft, setDraft] = useState<ProfileLabel[]>(labels);
  const [isSaving, setIsSaving] = useState(false);
  const labelsRef = useRef<ProfileLabelsRef>(null);

  // Re-seed on open so a cancelled edit does not leak into the next row: the
  // dialog is mounted once per page and reused for whichever row is picked.
  useEffect(() => {
    if (open) setDraft(labels);
  }, [open, labels]);

  const handleSave = async () => {
    // A key/value pair typed but not yet added with "+" is still the user's
    // intent, so commit it rather than dropping it on save.
    const pending = labelsRef.current?.saveUnsavedLabel();
    setIsSaving(true);
    try {
      await onSave(pending ?? draft);
      onOpenChange(false);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Edit labels</DialogTitle>
          <DialogDescription>
            Key/value labels for {entityName}. Labels are how this list is
            filtered.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <ProfileLabels
            ref={labelsRef}
            labels={draft}
            onLabelsChange={setDraft}
            showLabel={false}
          />
        </DialogBody>
        <DialogStickyFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
          >
            Cancel
          </Button>
          <Button type="button" onClick={handleSave} disabled={isSaving}>
            {isSaving ? "Saving..." : "Save labels"}
          </Button>
        </DialogStickyFooter>
      </DialogContent>
    </Dialog>
  );
}

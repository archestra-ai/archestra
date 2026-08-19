"use client";

import { useMemo } from "react";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { SkillContentEditor } from "./skill-content-editor";
import { type SkillPreview, skillDraftFromPreview } from "./skill-draft";

/** Read-only look at a skill that has not been imported yet. */
export function SkillPreviewDialog({
  preview,
  isLoading,
  open,
  onOpenChange,
}: {
  preview: SkillPreview | null;
  isLoading?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const draft = useMemo(
    () => (preview ? skillDraftFromPreview(preview) : null),
    [preview],
  );
  return (
    <StandardDialog
      open={open}
      onOpenChange={onOpenChange}
      title={preview?.name ?? "Preview skill"}
      description="Preview of a skill that has not been imported yet."
      size="large"
      bodyClassName="flex flex-col overflow-hidden"
      footer={
        <Button
          type="button"
          variant="outline"
          onClick={() => onOpenChange(false)}
        >
          Close
        </Button>
      }
    >
      {isLoading || !draft ? (
        <div className="py-10 text-center text-sm text-muted-foreground">
          <span>Loading skill...</span>
        </div>
      ) : (
        <SkillContentEditor
          manifest={draft.manifest}
          files={draft.files}
          onManifestChange={() => {}}
          onFilesChange={() => {}}
          readOnly
          isPreview
          className="h-full"
        />
      )}
    </StandardDialog>
  );
}

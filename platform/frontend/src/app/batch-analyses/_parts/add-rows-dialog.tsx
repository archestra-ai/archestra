"use client";

import { useState } from "react";
import {
  draftIsSubmittable,
  draftToRows,
  EMPTY_ROW_SOURCE_DRAFT,
  type RowSourceDraft,
  RowSourcePicker,
  useUploadRowSourceFiles,
} from "@/app/batch-analyses/_parts/row-source-picker";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { DialogStickyFooter } from "@/components/ui/dialog";
import { useAddBatchAnalysisRows } from "@/lib/batch-analysis/batch-analysis.query";

export function AddRowsDialog({
  analysisId,
  open,
  onOpenChange,
}: {
  analysisId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [draft, setDraft] = useState<RowSourceDraft>(EMPTY_ROW_SOURCE_DRAFT);
  const [failures, setFailures] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const addRows = useAddBatchAnalysisRows(analysisId);
  const uploadFiles = useUploadRowSourceFiles();

  const handleAdd = async () => {
    setBusy(true);
    setFailures([]);
    try {
      let rows = draftToRows(draft);
      let failed: string[] = [];
      if (draft.tab === "upload") {
        ({ rows, failures: failed } = await uploadFiles(draft.files));
      }
      if (rows.length > 0) {
        await addRows.mutateAsync({ rows });
      }
      if (failed.length > 0) {
        // The uploaded ones are already rows; keep only the failures staged so
        // a retry cannot duplicate what worked.
        setFailures(failed);
        setDraft({
          ...draft,
          files: draft.files.filter((file) => failed.includes(file.name)),
        });
        return;
      }
      setDraft(EMPTY_ROW_SOURCE_DRAFT);
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add rows"
      description="Each source you add becomes one row, analysed against every column."
      size="medium"
      className="max-w-2xl"
    >
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        <RowSourcePicker draft={draft} onDraftChange={setDraft} />

        {failures.length > 0 && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
            <p className="font-medium text-destructive text-sm">
              Could not add {failures.length}{" "}
              {failures.length === 1 ? "file" : "files"}
            </p>
            <p className="mt-1 text-muted-foreground text-xs">
              {failures.join(", ")}. A file the repository cannot read — a
              scanned PDF with no text layer, or an image — has nothing to
              analyse.
            </p>
          </div>
        )}
      </div>

      <DialogStickyFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          <span>Cancel</span>
        </Button>
        <Button
          disabled={busy || !draftIsSubmittable(draft)}
          onClick={() => void handleAdd()}
        >
          <span>
            {busy
              ? draft.tab === "upload"
                ? "Uploading…"
                : "Adding…"
              : "Add rows"}
          </span>
        </Button>
      </DialogStickyFooter>
    </FormDialog>
  );
}

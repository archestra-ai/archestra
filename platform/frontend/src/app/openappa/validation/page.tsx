"use client";

import { useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { useValidation } from "./_parts/validation-context";
import { canDeleteValidations, ValidationList } from "./_parts/validation-list";
import { useValidationRunner } from "./_parts/validation-runner";

export default function ValidationPage() {
  const suite = useValidation();
  const runner = useValidationRunner();
  // Open is tracked apart from the files so the dialog keeps its title
  // through the close animation instead of flashing "Delete 0 files".
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteIds, setDeleteIds] = useState<string[]>([]);
  const requestDelete = (paths: string[]) => {
    setDeleteIds(paths);
    setDeleteOpen(true);
  };
  const single = deleteIds.length === 1;
  const canDelete = canDeleteValidations(suite);
  return (
    <>
      <ValidationList
        runAll={runner.startRunAll}
        runFile={runner.startRunFile}
        openRun={(runId) => {
          const run = suite.history.data?.find((item) => item.id === runId);
          if (run) runner.openRun(run);
        }}
        requestDelete={
          !suite.github && suite.canWrite ? requestDelete : undefined
        }
      />
      <DeleteConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete ${deleteIds.length} validation ${single ? "file" : "files"}?`}
        description={
          single
            ? "This validation file will be deleted."
            : "These validation files will be deleted."
        }
        isPending={suite.busy}
        confirmDisabled={!canDelete}
        onConfirm={() => {
          suite.deleteFiles(deleteIds, () => setDeleteOpen(false));
        }}
      />
    </>
  );
}

"use client";

import { useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { useValidation } from "./_parts/validation-context";
import { canDeleteValidations, ValidationList } from "./_parts/validation-list";
import { useValidationRunner } from "./_parts/validation-runner";

export default function ValidationPage() {
  const suite = useValidation();
  const runner = useValidationRunner();
  const [deleteIds, setDeleteIds] = useState<string[]>([]);
  const canDelete = canDeleteValidations(suite);
  return (
    <>
      <ValidationList
        runAll={runner.startRunAll}
        runFile={suite.runFile}
        openRun={(runId) => {
          const run = suite.history.data?.find((item) => item.id === runId);
          if (run) runner.openRun(run);
        }}
        requestDelete={
          !suite.github && suite.canWrite ? setDeleteIds : undefined
        }
      />
      <DeleteConfirmDialog
        open={deleteIds.length > 0}
        onOpenChange={(open) => {
          if (!open) setDeleteIds([]);
        }}
        title={`Delete ${deleteIds.length} validation ${deleteIds.length === 1 ? "file" : "files"}?`}
        description="These validation files will be deleted."
        isPending={suite.busy}
        confirmDisabled={!canDelete}
        onConfirm={() => {
          suite.deleteFiles(deleteIds, () => setDeleteIds([]));
        }}
      />
    </>
  );
}

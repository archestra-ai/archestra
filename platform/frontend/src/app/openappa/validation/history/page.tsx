"use client";

import { useMemo } from "react";
import { QueryLoadError } from "@/components/query-load-error";
import {
  OpenAppaPageHeader,
  useOpenAppaDetailHeader,
} from "../../_parts/openappa-page-action";
import { validationName } from "../../_parts/validation-run-history";
import { useValidation } from "../_parts/validation-context";
import { ValidationRunMatrix } from "../_parts/validation-run-matrix";
import { useValidationRunner } from "../_parts/validation-runner";

export default function ValidationHistoryPage() {
  const { files, history } = useValidation();
  const runner = useValidationRunner();
  useOpenAppaDetailHeader(DETAIL_HEADER);
  const names = useMemo(
    () =>
      Object.fromEntries(
        files.map((file) => [file.path, validationName(file)]),
      ),
    [files],
  );
  return (
    <div className="space-y-4">
      <OpenAppaPageHeader
        title="Run history"
        description="Every validation run, newest on the right."
      />
      {history.isError ? (
        <QueryLoadError
          title="Could not load run history"
          error={history.error}
          onRetry={() => history.refetch()}
        />
      ) : (
        <ValidationRunMatrix
          runs={history.data ?? []}
          isLoading={history.isLoading}
          names={names}
          onOpenRun={(runId) => {
            const run = history.data?.find((item) => item.id === runId);
            if (run) runner.openRun(run);
          }}
        />
      )}
    </div>
  );
}

const DETAIL_HEADER = { back: true };

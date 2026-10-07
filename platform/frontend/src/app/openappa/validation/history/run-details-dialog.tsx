"use client";

import { TriangleAlert } from "lucide-react";
import { StandardDialog } from "@/components/standard-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import type { PolicyTestRun } from "@/lib/openappa-policy-tests.query";
import { formatDate } from "@/lib/utils/date-time";
import {
  StepResults,
  statusLabel,
  ValidationRunOutcome,
  ValidationStatusBadge,
} from "../validation-parts";

export function RunDetailsDialog({
  run,
  onClose,
}: {
  run: PolicyTestRun | null;
  onClose: () => void;
}) {
  return (
    <StandardDialog
      open={run !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Validation run details"
      description={
        run
          ? `${formatDate({ date: run.createdAt })} · Policy revision ${run.policyRevision}`
          : undefined
      }
      size="large"
      footer={
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      }
    >
      {run && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <ValidationRunOutcome run={run} />
            {run.draft && <Badge variant="secondary">Draft run</Badge>}
            {run.stale && <Badge variant="outline">Stale inputs</Badge>}
          </div>
          {run.validation.errors.length > 0 && (
            <InlineNotice variant="error">
              <TriangleAlert />
              <span className="font-medium">Policy validation failed</span>
              <InlineNoticeText>
                {run.validation.errors.join("\n")}
              </InlineNoticeText>
            </InlineNotice>
          )}
          {run.executionError && (
            <InlineNotice variant="warning">
              <TriangleAlert />
              <span className="font-medium">Validation could not run</span>
              <InlineNoticeText>{run.executionError}</InlineNoticeText>
            </InlineNotice>
          )}
          {run.validation.warnings.length > 0 && (
            <InlineNotice>
              <TriangleAlert />
              <span className="font-medium">Policy warnings</span>
              <InlineNoticeText>
                {run.validation.warnings.join("\n")}
              </InlineNoticeText>
            </InlineNotice>
          )}
          {run.files.map((file) => (
            <section
              key={file.path}
              aria-label={file.path}
              className="space-y-2 rounded-md border p-4"
            >
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="break-all font-mono text-sm font-medium">
                  {file.path}
                </h3>
                <ValidationStatusBadge status={file.status} />
              </div>
              <p className="text-xs text-muted-foreground">{`${file.steps.length} of ${file.assertionCount} assertions evaluated`}</p>
              {file.status === "passed" && (
                <p className="text-sm">
                  All evaluated assertions matched their expected decisions.
                </p>
              )}
              {file.status === "failed" && (
                <p className="text-sm">
                  An actual decision differed from its expectation.
                </p>
              )}
              {file.error && (
                <InlineNotice
                  variant={file.status === "cannot_run" ? "warning" : "error"}
                >
                  <TriangleAlert />
                  <span className="font-medium">
                    {statusLabel(file.status)}
                  </span>
                  <InlineNoticeText>{file.error}</InlineNoticeText>
                </InlineNotice>
              )}
              {file.steps.length > 0 ? (
                <StepResults steps={file.steps} />
              ) : (
                !file.error && (
                  <p className="text-sm">No assertion details were recorded.</p>
                )
              )}
            </section>
          ))}
        </div>
      )}
    </StandardDialog>
  );
}

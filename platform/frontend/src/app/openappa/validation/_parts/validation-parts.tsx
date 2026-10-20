"use client";
import { Info, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { useAppaGithubSync } from "@/lib/openappa-github-sync.query";
import type { PolicyTestRun } from "@/lib/openappa-policy-tests.query";
import { GithubManagedPolicyNotice } from "../../_parts/github-managed-policy-notice";
import { validationSuiteSummary } from "../../_parts/validation-run-history";
import { useValidation } from "./validation-context";

export function ValidationNotices({
  sourceChanged: editorSourceChanged = false,
  hideManagedChip = false,
}: {
  sourceChanged?: boolean;
  /** The page links to the repository from its ⋯ menu instead. */
  hideManagedChip?: boolean;
} = {}) {
  const {
    github,
    collection,
    sourceChanged: collectionChanged,
    validPaths,
    loadError,
  } = useValidation();
  const sourceChanged = collectionChanged || editorSourceChanged;
  // Until the setup PR merges, sync has no accepted commit to read validations
  // from; the merge notice above says what to do, so skip the error.
  const sync = useAppaGithubSync();
  const awaitingSetupMerge =
    github && !!sync.data?.source?.setupPullRequestNumber;
  if (
    !github &&
    !collection.error &&
    !sourceChanged &&
    validPaths &&
    !loadError
  )
    return null;
  return (
    <div className="space-y-2">
      {loadError && (
        <InlineNotice variant="error">
          <Info />
          <span className="font-medium">Could not refresh validation</span>
          <InlineNoticeText>
            {loadError.message} If you have unsaved edits, export them before
            refreshing the page.
          </InlineNoticeText>
        </InlineNotice>
      )}
      {github && (
        <GithubManagedPolicyNotice
          validationDirectory={collection.activeDirectory}
          hideHealthy={hideManagedChip}
        />
      )}
      {collection.error && !awaitingSetupMerge && (
        <InlineNotice variant="error">
          <TriangleAlert />
          <span className="font-medium">Validation unavailable</span>
          <InlineNoticeText>{collection.error}</InlineNoticeText>
        </InlineNotice>
      )}
      {sourceChanged && (
        <InlineNotice>
          <TriangleAlert />
          <span className="font-medium">Validation source changed</span>
          <InlineNoticeText>
            Export any draft you want to keep, then refresh the page before
            saving or running.
          </InlineNoticeText>
        </InlineNotice>
      )}
      {!validPaths && (
        <InlineNotice>
          <TriangleAlert />
          <span className="font-medium">Check filenames</span>
          <InlineNoticeText>
            Each file needs a unique path ending in .appa.
          </InlineNoticeText>
        </InlineNotice>
      )}
    </div>
  );
}

/** What the per-file statuses cannot say: history did not load, or the last run never started. */
export function ValidationRunNotices() {
  const { files, history } = useValidation();
  const summary = history.data
    ? validationSuiteSummary(files, history.data)
    : null;
  if (!history.isError && !summary?.error) return null;
  return (
    <div className="space-y-2">
      {history.isError && (
        <InlineNotice variant="error">
          <TriangleAlert />
          <span className="font-medium">Could not load run history</span>
          <Button
            size="xs"
            variant="outline"
            className="ml-auto"
            onClick={() => history.refetch()}
          >
            Retry
          </Button>
        </InlineNotice>
      )}
      {summary?.error && (
        <InlineNotice variant="warning">
          <TriangleAlert />
          <span className="font-medium">Validation could not run</span>
          <InlineNoticeText>{summary.error}</InlineNoticeText>
        </InlineNotice>
      )}
    </div>
  );
}

export function ValidationStatusBadge({
  status,
  children,
}: {
  status: string;
  children?: ReactNode;
}) {
  const color =
    status === "passed"
      ? "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-400"
      : status === "failed"
        ? "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400"
        : status === "cannot_run"
          ? "border-yellow-500/30 bg-yellow-500/10 text-yellow-800 dark:text-yellow-300"
          : undefined;
  return (
    <Badge variant="outline" className={color}>
      {children ?? statusLabel(status)}
    </Badge>
  );
}

export function statusLabel(status: string) {
  return status === "cannot_run"
    ? "Cannot run"
    : status === "passed"
      ? "Passed"
      : status === "failed"
        ? "Failed"
        : status === "not_run"
          ? "Not run"
          : status;
}

export function ValidationRunDiagnostics({
  run,
}: {
  run: Pick<PolicyTestRun, "validation" | "executionError">;
}) {
  const notices = [
    {
      title: "Policy validation failed",
      message: run.validation.errors.join("\n"),
      variant: "error",
    },
    {
      title: "Validation could not run",
      message: run.executionError,
      variant: "warning",
    },
    {
      title: "Policy warnings",
      message: run.validation.warnings.join("\n"),
      variant: undefined,
    },
  ] as const;
  return notices.map(({ title, message, variant }) =>
    message ? (
      <InlineNotice key={title} variant={variant}>
        <TriangleAlert />
        <span className="font-medium">{title}</span>
        <InlineNoticeText>{message}</InlineNoticeText>
      </InlineNotice>
    ) : null,
  );
}

/** Downloads one validation file, e.g. a draft to keep before refreshing. */
export function exportValidationFile(file: { path: string; content: string }) {
  const url = URL.createObjectURL(
    new Blob([file.content], { type: "text/plain;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.path.split("/").pop() ?? "scenario.appa";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

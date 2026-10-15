"use client";
import {
  Clock,
  History,
  Info,
  MessageCircle,
  Play,
  TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAppaGithubSync } from "@/lib/openappa-github-sync.query";
import type { PolicyTestRun } from "@/lib/openappa-policy-tests.query";
import { formatDate } from "@/lib/utils/date-time";
import { GithubManagedPolicyNotice } from "../../_parts/github-managed-policy-notice";
import { OpenAppaChatButton } from "../../_parts/openappa-chat-button";
import { useValidationFileHashes } from "../../_parts/use-validation-file-hashes";
import {
  currentValidationRun,
  validationRunStatus,
} from "../../_parts/validation-run-history";
import { useValidation } from "./validation-context";

export function ValidationNotices({
  sourceChanged: editorSourceChanged = false,
}: {
  sourceChanged?: boolean;
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

export function ValidationActions() {
  const { busy } = useValidation();
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <OpenAppaChatButton
        size="sm"
        variant="outline"
        promptKey="explainValidations"
        disabled={busy}
      >
        <Info />
        <span>Explain validations</span>
      </OpenAppaChatButton>
      <OpenAppaChatButton
        size="sm"
        variant="outline"
        promptKey="writeValidations"
        permissions={{ openappaPolicy: ["read", "update"] }}
        disabled={busy}
      >
        <MessageCircle />
        <span>Write a validation</span>
      </OpenAppaChatButton>
    </div>
  );
}

export function ValidationRunAction() {
  const { files, runnable, runAll } = useValidation();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" asChild>
        <Link href="/openappa/validation/history">
          <History />
          <span>Run history</span>
        </Link>
      </Button>
      <Button size="sm" disabled={!runnable || !files.length} onClick={runAll}>
        <Play />
        <span>Run all</span>
      </Button>
    </div>
  );
}

export function ValidationLastRun() {
  const { files, history } = useValidation();
  const hashes = useValidationFileHashes(files);
  const run = hashes.data
    ? currentValidationRun(hashes.data, history.data ?? [])
    : null;
  const passed = run?.files.filter((file) => file.status === "passed").length;
  return (
    <div className="space-y-2">
      {run && (
        <InlineNotice
          variant="neutral"
          role="status"
          aria-label="Last validation run"
        >
          <Clock />
          <span className="font-medium">Last run</span>
          <InlineNoticeText>
            {formatDate({ date: run.createdAt })}
          </InlineNoticeText>
          <ValidationStatusBadge status={validationRunStatus(run)}>
            {run.files.length
              ? `${passed} of ${run.files.length} passed`
              : "Cannot run"}
          </ValidationStatusBadge>
          {run.trigger === "github_sync" && (
            <Badge variant="outline">Git sync run</Badge>
          )}
          {run.trigger === "policy_change" && (
            <Badge variant="outline">Policy change run</Badge>
          )}
          {run.draft && <Badge variant="secondary">Draft run</Badge>}
        </InlineNotice>
      )}
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
      {run && <ValidationRunDiagnostics run={run} />}
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

export function ValidationRunOutcome({
  run,
  binary = false,
}: {
  run: PolicyTestRun;
  binary?: boolean;
}) {
  if (run.executionError)
    return <ValidationStatusBadge status={binary ? "failed" : "cannot_run"} />;
  const passed = run.files.filter((file) => file.status === "passed").length;
  const failed = run.files.filter((file) => file.status === "failed").length;
  const cannotRun = run.files.filter(
    (file) => file.status === "cannot_run",
  ).length;
  return (
    <div className="flex flex-wrap gap-2">
      <ValidationStatusBadge status="passed">
        {passed} passed
      </ValidationStatusBadge>
      <ValidationStatusBadge status="failed">
        {failed + (binary ? cannotRun : 0)} failed
      </ValidationStatusBadge>
      {!binary && (
        <ValidationStatusBadge status="cannot_run">
          {cannotRun} cannot run
        </ValidationStatusBadge>
      )}
    </div>
  );
}

export function StepResults({
  steps,
}: {
  steps: PolicyTestRun["files"][number]["steps"];
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Line / tool</TableHead>
          <TableHead>Expected</TableHead>
          <TableHead>Actual</TableHead>
          <TableHead>Result</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {steps.map((step) => (
          <TableRow key={`${step.line}:${step.tool}`}>
            <TableCell>
              <span className="font-mono text-xs">{`${step.line} · ${step.tool}`}</span>
            </TableCell>
            <TableCell>{step.expected}</TableCell>
            <TableCell>{step.actual ?? "—"}</TableCell>
            <TableCell>
              <div className="space-y-1">
                <ValidationStatusBadge status={step.status} />
                {step.error && (
                  <p className="whitespace-pre-wrap text-xs">{step.error}</p>
                )}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function statusLabel(status: string) {
  return status === "cannot_run"
    ? "Cannot run"
    : status === "passed"
      ? "Passed"
      : status === "failed"
        ? "Failed"
        : status === "stale"
          ? "Stale result"
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

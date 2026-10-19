"use client";

import type { OnMount } from "@monaco-editor/react";
import {
  Download,
  Loader2,
  Play,
  Save,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { Editor } from "@/components/editor";
import { PageBackLink } from "@/components/page-back-link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import {
  UnsavedChangesDialog,
  useBeforeUnloadWhileDirty,
  useGuardedInAppNavigation,
  useUnsavedChangesGuard,
} from "@/components/unsaved-changes-guard";
import { useListReturnHref } from "@/lib/hooks/use-list-return-url";
import {
  type PolicyTestCollection,
  type PolicyTestPreview,
  usePreviewOpenAppaPolicyTest,
} from "@/lib/openappa-policy-tests.query";
import { formatDate } from "@/lib/utils/date-time";
import { focusPolicyLine } from "../../_parts/policy-decorations";
import { POLICY_EDITOR_OPTIONS } from "../../_parts/policy-editor-options";
import {
  latestFileResult,
  mismatchedStep,
  validationFileStates,
} from "../../_parts/validation-run-history";
import { useValidationHistoryGuard } from "../_parts/use-validation-history-guard";
import {
  useValidation,
  useValidationInspection,
  validationFileHref,
} from "../_parts/validation-context";
import {
  clearValidationDraft,
  getValidationDraft,
  retainValidationDraft,
} from "../_parts/validation-draft";
import {
  exportValidationFile,
  FailedStepNotice,
  StepResults,
  statusLabel,
  ValidationNotices,
  ValidationRunDiagnostics,
  ValidationStatusBadge,
} from "../_parts/validation-parts";

export default function ValidationFilePage() {
  const path = useSearchParams().get("path") ?? "";
  return <ValidationFileEditor key={path} path={path} />;
}

function ValidationFileEditor({ path }: { path: string }) {
  const suite = useValidation();
  const listHref = useListReturnHref("/openappa/validation");
  const route = `file:${path}`;
  const [restored] = useState(() =>
    getValidationDraft(suite.sessionKey, route),
  );
  const [baseline, setBaseline] = useState(
    restored?.baseline ?? suite.collection,
  );
  const baselineFile = baseline.files.find((file) => file.path === path);
  const form = useForm<PolicyTestCollection["files"][number]>({
    defaultValues: restored?.values ?? baselineFile ?? { path, content: "" },
  });
  const file = baselineFile ? form.watch() : undefined;
  const fileDirty = Boolean(
    file && JSON.stringify(file) !== JSON.stringify(baselineFile),
  );
  const sourceChanged =
    suite.sourceChanged ||
    baseline.version !== suite.collection.version ||
    baseline.source !== suite.collection.source ||
    baseline.activeDirectory !== suite.collection.activeDirectory;
  useEffect(() => {
    if (fileDirty || baseline === suite.collection) return;
    const current = suite.collection.files.find((file) => file.path === path);
    form.reset(current ?? { path, content: "" });
    setBaseline(suite.collection);
  }, [fileDirty, baseline, suite.collection, path, form]);
  useLayoutEffect(() => {
    if (fileDirty && file)
      retainValidationDraft({
        scope: suite.sessionKey,
        route,
        baseline,
        values: file,
      });
    else clearValidationDraft(suite.sessionKey, route);
  }, [fileDirty, file, baseline, route, suite.sessionKey]);
  function clearDraft() {
    clearValidationDraft(suite.sessionKey, route);
  }
  function discardDraft() {
    clearDraft();
    form.reset(baselineFile);
  }
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const nextHref = useRef(listHref);
  const guard = useUnsavedChangesGuard({
    isDirty: fileDirty,
    onOpenChange: (open) => {
      if (!open) {
        discardDraft();
        router.push(nextHref.current);
      }
    },
  });
  useBeforeUnloadWhileDirty(fileDirty);
  useValidationHistoryGuard(fileDirty, discardDraft);
  useGuardedInAppNavigation({
    isDirty: fileDirty,
    onRequestNavigate: (href) => {
      nextHref.current = href;
      guard.requestClose();
    },
  });
  const previewMutation = usePreviewOpenAppaPolicyTest();
  const [preview, setPreview] = useState<{
    file: { path: string; content: string };
    run: PolicyTestPreview;
  } | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const router = useRouter();
  // An editor test describes the text it tested; editing again drops it.
  const previewRun =
    preview && JSON.stringify(preview.file) === JSON.stringify(file)
      ? preview.run
      : undefined;
  // The file shows its last recorded result, also while it is edited, until
  // it runs again or an editor test of the draft replaces it.
  const recorded =
    !previewRun && suite.history.data
      ? {
          latest: latestFileResult({ path }, suite.history.data),
          state: validationFileStates([{ path }], suite.history.data).get(path),
        }
      : null;
  const running = suite.runningPath === path;
  const result = previewRun?.files[0] ?? recorded?.latest?.result;
  // A decision that did not match gets its own card; any other failure
  // (a refused policy, a run or step that could not run) stays as text.
  const failedStep = recorded
    ? recorded.state?.failedStep
    : result && !result.error
      ? mismatchedStep(result.steps)
      : null;
  const [editor, setEditor] = useState<Parameters<OnMount>[0] | null>(null);
  const busy = suite.busy || previewMutation.isPending;
  const runnable = Boolean(
    file &&
      /^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*\.appa$/.test(file.path) &&
      !file.path.split("/").some((part) => part === "." || part === "..") &&
      suite.canWrite &&
      !busy &&
      !sourceChanged &&
      !suite.collection.error &&
      !suite.loadError,
  );
  const validPath = Boolean(
    file &&
      /^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*\.appa$/.test(file.path) &&
      !file.path.split("/").some((part) => part === "." || part === ".."),
  );
  const validPaths =
    validPath &&
    !suite.files.some(
      (current) => current.path !== path && current.path === file?.path,
    );
  const inspection = useValidationInspection(
    file ? [file] : [],
    Boolean(
      file &&
        validPath &&
        !sourceChanged &&
        !suite.collection.error &&
        !suite.loadError,
    ),
  );
  const summary = inspection.summaries?.[0];
  function saved(next: PolicyTestCollection) {
    if (!file || !mounted.current) return;
    clearDraft();
    setBaseline(next);
    form.reset(file);
    if (path !== file.path)
      router.replace(validationFileHref(file.path), { scroll: false });
  }
  return (
    <div className="space-y-4">
      <PageBackLink href={listHref} labelled>
        <span>Back to validation</span>
      </PageBackLink>
      <ValidationNotices sourceChanged={sourceChanged} />
      {summary?.error && (
        <InlineNotice variant="error">
          <TriangleAlert />
          <span className="font-medium">Invalid validation syntax</span>
          <InlineNoticeText>{summary.error}</InlineNoticeText>
        </InlineNotice>
      )}
      {!file ? (
        <InlineNotice>
          <TriangleAlert />
          <span className="font-medium">Validation file unavailable</span>
          <InlineNoticeText>
            This full path is not in the current collection. Return to the list
            or refresh the page.
          </InlineNoticeText>
        </InlineNotice>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <Input
                {...form.register("path")}
                aria-label="Validation filename"
                className="max-w-xl font-mono"
                readOnly={suite.github || !suite.canWrite || busy}
              />
              <ValidationStatusBadge
                status={
                  previewRun
                    ? (result?.status ?? "not_run")
                    : (recorded?.state?.status ?? "not_run")
                }
              />
              {recorded?.state?.runAt && (
                <Link
                  href="/openappa/validation/history"
                  className="whitespace-nowrap text-sm text-muted-foreground hover:text-foreground"
                >
                  {`${formatDate({ date: recorded.state.runAt, dateFormat: "MM/dd HH:mm" })} · ${recorded.state.runLabel}`}
                </Link>
              )}
              {fileDirty && <Badge variant="secondary">Unsaved draft</Badge>}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => exportValidationFile(file)}
              >
                <Download />
                <span>Export</span>
              </Button>
              {!suite.github && suite.canWrite && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={
                      !fileDirty || !validPaths || busy || sourceChanged
                    }
                    onClick={() => {
                      if (file) suite.save(path, file, baseline.version, saved);
                    }}
                  >
                    <Save />
                    <span>Save validation</span>
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Delete ${file.path}`}
                    disabled={busy}
                    onClick={() => setDeleteOpen(true)}
                  >
                    <Trash2 />
                  </Button>
                </>
              )}
              <Button
                size="sm"
                disabled={!runnable}
                onClick={() => {
                  // A saved file runs for real and lands in run history; a
                  // draft can only be tried in the editor.
                  if (!fileDirty) {
                    setPreview(null);
                    suite.runFile(path);
                    return;
                  }
                  const captured = structuredClone(file);
                  setPreview(null);
                  previewMutation.mutate(
                    {
                      files: [captured],
                      sourceVersion: baseline.version,
                      directory: baseline.directory,
                    },
                    {
                      onSuccess: (run) => {
                        if (run) setPreview({ file: captured, run });
                      },
                    },
                  );
                }}
              >
                {running || previewMutation.isPending ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Play />
                )}
                <span>{fileDirty ? "Test draft" : "Run file"}</span>
              </Button>
            </div>
          </div>
          {/* Why the file did not pass, above the tall editor so it is seen. */}
          {failedStep ? (
            <FailedStepNotice
              step={failedStep}
              onShowLine={
                editor
                  ? () => focusPolicyLine(editor, failedStep.line)
                  : undefined
              }
            />
          ) : (
            result &&
            (recorded ? recorded.state?.error : result.error) && (
              <InlineNotice
                variant={
                  (recorded?.state?.status ?? result.status) === "failed"
                    ? "error"
                    : "warning"
                }
              >
                <TriangleAlert />
                <span className="font-medium">
                  {statusLabel(recorded?.state?.status ?? result.status)}
                </span>
                <InlineNoticeText className="whitespace-pre-wrap">
                  {recorded ? recorded.state?.error : result.error}
                </InlineNoticeText>
              </InlineNotice>
            )
          )}
          <Card className="overflow-hidden py-0">
            <CardContent className="px-0">
              <Controller
                control={form.control}
                name="content"
                render={({ field }) => (
                  <Editor
                    height="55vh"
                    language="plaintext"
                    value={field.value}
                    onChange={(value) => field.onChange(value ?? "")}
                    onMount={setEditor}
                    options={{
                      ...POLICY_EDITOR_OPTIONS,
                      readOnly: !suite.canWrite || busy,
                      ariaLabel: `Policy validation ${file.path}`,
                    }}
                  />
                )}
              />
            </CardContent>
          </Card>
          {previewMutation.isError && (
            <InlineNotice variant="error">
              <TriangleAlert />
              <span className="font-medium">File test could not run</span>
              <InlineNoticeText>
                {previewMutation.error.message}
              </InlineNoticeText>
            </InlineNotice>
          )}
          {previewRun && <ValidationRunDiagnostics run={previewRun} />}
          {result && (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">{`${result.steps.length} of ${result.assertionCount} assertions evaluated`}</p>
              {result.steps.length > 0 && <StepResults steps={result.steps} />}
            </div>
          )}
        </>
      )}
      <DeleteConfirmDialog
        open={deleteOpen && Boolean(file)}
        onOpenChange={setDeleteOpen}
        title={`Delete ${file?.path ?? "validation"}?`}
        description="This validation file will be deleted."
        isPending={busy}
        confirmDisabled={
          suite.github ||
          !suite.canWrite ||
          sourceChanged ||
          Boolean(suite.loadError || suite.collection.error)
        }
        onConfirm={() =>
          suite.deleteFiles([path], () => {
            clearDraft();
            router.push(listHref);
          })
        }
      />
      <UnsavedChangesDialog
        open={guard.confirmOpen}
        onKeepEditing={guard.keepEditing}
        onDiscard={guard.discardChanges}
      />
    </div>
  );
}

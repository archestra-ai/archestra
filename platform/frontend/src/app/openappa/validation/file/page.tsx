"use client";

import { Download, Play, Save, Trash2, TriangleAlert } from "lucide-react";
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
import { useGuardrailsPolicy } from "@/lib/guardrails-policy.query";
import { useEffectivePolicy } from "@/lib/openappa-batteries.query";
import {
  type PolicyTestCollection,
  type PolicyTestPreview,
  usePreviewOpenAppaPolicyTest,
} from "@/lib/openappa-policy-tests.query";
import { POLICY_EDITOR_OPTIONS } from "../../_parts/policy-editor-options";
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
import { exportValidationFile } from "../_parts/validation-file";
import {
  StepResults,
  statusLabel,
  ValidationNotices,
  ValidationStatusBadge,
} from "../_parts/validation-parts";

export default function ValidationFilePage() {
  const path = useSearchParams().get("path") ?? "";
  return <ValidationFileEditor key={path} path={path} />;
}

function ValidationFileEditor({ path }: { path: string }) {
  const suite = useValidation();
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
  const nextHref = useRef(suite.listHref);
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
  const previewRun = preview?.run;
  const policy = useGuardrailsPolicy();
  const effectivePolicy = useEffectivePolicy(Boolean(previewRun), 10000);
  const result = previewRun?.files[0];
  const stale = Boolean(
    previewRun &&
      (previewRun.stale ||
        previewRun.sourceVersion !== baseline.version ||
        sourceChanged ||
        suite.loadError ||
        policy.isError ||
        effectivePolicy.isError ||
        (policy.data && policy.data.contentHash !== previewRun.policyHash) ||
        (effectivePolicy.data &&
          effectivePolicy.data.contentHash !==
            previewRun.effectivePolicyHash) ||
        JSON.stringify(preview?.file) !== JSON.stringify(file)),
  );
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
      <PageBackLink href={suite.listHref}>
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
                status={result ? (stale ? "stale" : result.status) : "not_run"}
              />
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
                <Play />
                <span>Run file</span>
              </Button>
            </div>
          </div>
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
          {previewRun && (
            <InlineNotice variant="neutral">
              <Play />
              <span className="font-medium">Editor test</span>
              <InlineNoticeText>
                This temporary result does not update the suite or run history.
              </InlineNoticeText>
            </InlineNotice>
          )}
          {previewRun && previewRun.validation.errors.length > 0 && (
            <InlineNotice variant="error">
              <TriangleAlert />
              <span className="font-medium">Policy validation failed</span>
              <InlineNoticeText>
                {previewRun.validation.errors.join("\n")}
              </InlineNoticeText>
            </InlineNotice>
          )}
          {previewRun && previewRun.validation.warnings.length > 0 && (
            <InlineNotice>
              <TriangleAlert />
              <span className="font-medium">Policy warnings</span>
              <InlineNoticeText>
                {previewRun.validation.warnings.join("\n")}
              </InlineNoticeText>
            </InlineNotice>
          )}
          {result && (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">{`${result.steps.length} of ${result.assertionCount} assertions evaluated`}</p>
              {stale && (
                <InlineNotice>
                  <TriangleAlert />
                  <span className="font-medium">Stale inputs</span>
                  <InlineNoticeText>
                    These results belong to different policy or validation
                    inputs. Run again to validate this draft.
                  </InlineNoticeText>
                </InlineNotice>
              )}
              {result.error && (
                <InlineNotice
                  variant={result.status === "cannot_run" ? "warning" : "error"}
                >
                  <TriangleAlert />
                  <span className="font-medium">
                    {statusLabel(result.status)}
                  </span>
                  <InlineNoticeText>{result.error}</InlineNoticeText>
                </InlineNotice>
              )}
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
            router.push(suite.listHref);
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

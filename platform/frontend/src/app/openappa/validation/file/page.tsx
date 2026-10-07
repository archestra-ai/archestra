"use client";

import { Download, Play, Save, Trash2, TriangleAlert } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useRef, useState } from "react";
import { Controller } from "react-hook-form";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { Editor } from "@/components/editor";
import { PageBackLink } from "@/components/page-back-link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import { useGuardrailsPolicy } from "@/lib/guardrails-policy.query";
import { useEffectivePolicy } from "@/lib/openappa-batteries.query";
import {
  type PolicyTestPreview,
  usePreviewOpenAppaPolicyTest,
} from "@/lib/openappa-policy-tests.query";
import { POLICY_EDITOR_OPTIONS } from "../../_parts/policy-editor-options";
import { useValidation, validationFileHref } from "../validation-context";
import { exportValidationFile } from "../validation-file";
import {
  StepResults,
  statusLabel,
  ValidationNotices,
  ValidationStatusBadge,
} from "../validation-parts";

export default function ValidationFilePage() {
  const suite = useValidation();
  const previewMutation = usePreviewOpenAppaPolicyTest();
  const [preview, setPreview] = useState<{
    id: string;
    file: { path: string; content: string };
    run: PolicyTestPreview;
  } | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const router = useRouter();
  const params = useSearchParams();
  const path = params.get("path");
  const draft = params.get("draft");
  const route = `${path ?? ""}:${draft ?? ""}`;
  const active = useRef<{ route: string | null; id: string | null }>({
    route: null,
    id: null,
  });
  if (
    active.current.route !== route ||
    !suite.fields.some((field) => field.id === active.current.id)
  ) {
    const matches = suite.fields.filter(
      (_, index) => suite.files[index].path === path,
    );
    active.current = {
      route,
      id:
        matches.find((field) => field.id === draft)?.id ??
        (matches.length === 1 ? matches[0].id : null),
    };
  }
  const index = suite.fields.findIndex(
    (field) => field.id === active.current.id,
  );
  const file = suite.files[index];
  const previewRun = preview?.id === active.current.id ? preview.run : null;
  const policy = useGuardrailsPolicy();
  const effectivePolicy = useEffectivePolicy(Boolean(previewRun), 10000);
  const result = previewRun?.files[0];
  const stale = Boolean(
    previewRun &&
      (previewRun.stale ||
        previewRun.sourceVersion !== suite.baseline.version ||
        suite.sourceChanged ||
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
      !suite.sourceChanged &&
      !suite.collection.error &&
      !suite.loadError,
  );
  const fileDirty = Boolean(
    file &&
      JSON.stringify(file) !== JSON.stringify(suite.baseline.files[index]),
  );
  const summary = suite.summaries?.find((item) => item.path === file?.path);
  function updateHref() {
    if (file && suite.validPaths && path !== file.path)
      router.replace(validationFileHref(file.path), { scroll: false });
  }
  return (
    <div className="space-y-4">
      <PageBackLink href={suite.listHref}>
        <span>Back to validation</span>
      </PageBackLink>
      <ValidationNotices />
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
                {...suite.form.register(`files.${index}.path`)}
                aria-label="Validation filename"
                className="max-w-xl font-mono"
                readOnly={suite.github || !suite.canWrite || busy}
                onBlur={updateHref}
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
                      !fileDirty ||
                      !suite.validPaths ||
                      busy ||
                      suite.sourceChanged
                    }
                    onClick={() => suite.save(index, updateHref)}
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
                  const id = suite.fields[index].id;
                  setPreview(null);
                  previewMutation.mutate(
                    {
                      files: [captured],
                      sourceVersion: suite.baseline.version,
                      directory: suite.baseline.directory,
                    },
                    {
                      onSuccess: (run) => {
                        if (run) setPreview({ id, file: captured, run });
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
                control={suite.form.control}
                name={`files.${index}.content`}
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
        description="This validation file will be deleted. Other unsaved edits will be kept."
        isPending={busy}
        confirmDisabled={
          suite.github ||
          !suite.canWrite ||
          suite.sourceChanged ||
          Boolean(suite.loadError || suite.collection.error)
        }
        onConfirm={() =>
          suite.deleteFiles([suite.fields[index].id], () =>
            router.push(suite.listHref),
          )
        }
      />
    </div>
  );
}

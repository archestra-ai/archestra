"use client";

import { Plus, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef } from "react";
import { Controller, useForm } from "react-hook-form";
import { Editor } from "@/components/editor";
import { PageBackLink } from "@/components/page-back-link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  UnsavedChangesDialog,
  useBeforeUnloadWhileDirty,
  useGuardedInAppNavigation,
  useUnsavedChangesGuard,
} from "@/components/unsaved-changes-guard";
import { POLICY_EDITOR_OPTIONS } from "../../_parts/policy-editor-options";
import { useValidation, validationFileHref } from "../validation-context";
import { ValidationNotices } from "../validation-parts";

export default function NewValidationPage() {
  const suite = useValidation();
  const router = useRouter();
  const paths = new Set(suite.baseline.files.map((file) => file.path));
  let number = suite.baseline.files.length + 1;
  while (paths.has(`scenario-${number}.appa`)) number += 1;
  const form = useForm<{ path: string; content: string }>({
    defaultValues: { path: `scenario-${number}.appa`, content: "" },
  });
  const nextHref = useRef(suite.listHref);
  const guard = useUnsavedChangesGuard({
    isDirty: form.formState.isDirty,
    onOpenChange: (open) => {
      if (!open) router.push(nextHref.current);
    },
  });
  useBeforeUnloadWhileDirty(form.formState.isDirty);
  useGuardedInAppNavigation({
    isDirty: form.formState.isDirty,
    onRequestNavigate: (href) => {
      nextHref.current = href;
      guard.requestClose();
    },
  });
  const disabled =
    suite.github ||
    !suite.canWrite ||
    suite.busy ||
    suite.dirty ||
    suite.sourceChanged ||
    Boolean(suite.loadError || suite.collection.error) ||
    suite.baseline.files.length >= 32;
  function cancel() {
    nextHref.current = suite.listHref;
    guard.requestClose();
  }
  return (
    <div className="space-y-4">
      <PageBackLink href={suite.listHref} onNavigate={cancel}>
        <span>Back to validation</span>
      </PageBackLink>
      <ValidationNotices />
      {suite.dirty && (
        <InlineNotice>
          <TriangleAlert />
          <span className="font-medium">Existing unsaved edits</span>
          <InlineNoticeText>
            Save or discard your existing file edits before creating a
            validation.
          </InlineNoticeText>
        </InlineNotice>
      )}
      {suite.baseline.files.length >= 32 && (
        <InlineNotice>
          <TriangleAlert />
          <span className="font-medium">File limit reached</span>
          <InlineNoticeText>
            Delete a file before adding another validation.
          </InlineNoticeText>
        </InlineNotice>
      )}
      {form.formState.errors.root && (
        <InlineNotice variant="error">
          <TriangleAlert />
          <span className="font-medium">Could not create validation</span>
          <InlineNoticeText>
            {form.formState.errors.root.message}
          </InlineNoticeText>
        </InlineNotice>
      )}
      <form
        className="space-y-4"
        onSubmit={form.handleSubmit((file) => {
          if (disabled) return;
          form.clearErrors("root");
          suite.createFile(
            file,
            () => {
              form.reset(file);
              router.push(validationFileHref(file.path));
            },
            (error) => form.setError("root", { message: error.message }),
          );
        })}
      >
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="w-full max-w-xl space-y-1.5">
            <Label htmlFor="new-validation-filename">Filename</Label>
            <Input
              id="new-validation-filename"
              className="font-mono"
              readOnly={disabled}
              aria-invalid={Boolean(form.formState.errors.path)}
              {...form.register("path", {
                validate: (path) => {
                  if (
                    !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*\.appa$/.test(
                      path,
                    ) ||
                    path
                      .split("/")
                      .some((part) => part === "." || part === "..")
                  )
                    return "Use a repository-relative filename ending in .appa.";
                  if (paths.has(path))
                    return "A validation with this filename already exists.";
                  return true;
                },
              })}
            />
            {form.formState.errors.path && (
              <p className="text-sm text-destructive">
                {form.formState.errors.path.message}
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={suite.busy}
              onClick={cancel}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={disabled}>
              <Plus />
              <span>{suite.busy ? "Creating…" : "Create validation"}</span>
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
                    readOnly: disabled,
                    ariaLabel: "New validation content",
                  }}
                />
              )}
            />
          </CardContent>
        </Card>
      </form>
      <UnsavedChangesDialog
        open={guard.confirmOpen}
        onKeepEditing={guard.keepEditing}
        onDiscard={guard.discardChanges}
      />
    </div>
  );
}

"use client";

import { DocsPage, getDocsUrl } from "@archestra/shared";
import type { OnMount } from "@monaco-editor/react";
import {
  Check,
  ExternalLink,
  FileCode2,
  Loader2,
  LockKeyhole,
  Save,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { Editor } from "@/components/editor";
import { QueryLoadError } from "@/components/query-load-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  UnsavedChangesDialog,
  useBeforeUnloadWhileDirty,
  useGuardedInAppNavigation,
  useUnsavedChangesGuard,
} from "@/components/unsaved-changes-guard";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  type GuardrailsPolicy,
  useGuardrailsPolicy,
  useUpdateGuardrailsPolicy,
  useValidateGuardrailsPolicy,
} from "@/lib/guardrails-policy.query";
import {
  type PolicyDeclarations,
  usePolicyDeclarations,
} from "@/lib/openappa-batteries.query";
import { useAppaGithubSync } from "@/lib/openappa-github-sync.query";
import { batteryDisplayName } from "./_parts/battery-display-name";
import { BatteryPolicySourceView } from "./_parts/battery-policy-source-view";
import { BATTERY_STATUS } from "./_parts/battery-status";
import { EffectivePolicyView } from "./_parts/effective-policy-view";
import {
  annotationDecorations,
  focusPolicyLine,
  policyAnnotations,
} from "./_parts/policy-decorations";
import { POLICY_EDITOR_OPTIONS } from "./_parts/policy-editor-options";

export function GuardrailsPolicyEditor({
  readOnly = false,
  sourceEntry,
  focusLine,
}: {
  readOnly?: boolean;
  sourceEntry?: string;
  focusLine?: number;
}) {
  const declarations = usePolicyDeclarations();
  const router = useRouter();
  const [tab, setTab] = useState<"policy" | "effective">("policy");
  return (
    // Editable drafts stay mounted while switching; the read-only details page
    // shows only the selected document so it never presents two editors.
    <Tabs
      className={readOnly ? "gap-0" : "-mt-4 gap-0"}
      value={tab}
      onValueChange={(next) => setTab(next === "effective" ? next : "policy")}
    >
      <TabsList className="h-auto w-full justify-start gap-0 rounded-none border-b bg-transparent p-0">
        <TabsTrigger
          className="h-10 flex-none rounded-none border-0 border-b-2 border-transparent px-4 shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none dark:data-[state=active]:bg-transparent"
          value="policy"
        >
          Policy
        </TabsTrigger>
        <TabsTrigger
          className="h-10 flex-none rounded-none border-0 border-b-2 border-transparent px-4 shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none dark:data-[state=active]:bg-transparent"
          value="effective"
        >
          Effective policy
        </TabsTrigger>
      </TabsList>
      {/* A force-mounted panel is never hidden by Radix, so the inactive one is hidden here. */}
      <TabsContent
        value="policy"
        forceMount={readOnly ? undefined : true}
        className="data-[state=inactive]:hidden"
      >
        {readOnly && (
          <div className="flex flex-wrap items-center gap-3 py-3">
            <span className="text-sm font-medium">Source</span>
            <SearchableSelect
              value={sourceEntry ?? "root"}
              onValueChange={(value) =>
                router.push(
                  value === "root"
                    ? "/openappa/policy"
                    : `/openappa/policy?${new URLSearchParams({ entry: value })}`,
                )
              }
              ariaLabel="Policy source file"
              searchPlaceholder="Search included batteries"
              className="w-72 max-w-full"
              pinnedItems={[{ value: "root", label: "Organization policy" }]}
              items={(declarations.data?.batteries ?? []).map((battery) => ({
                value: battery.entry,
                label: batteryDisplayName(battery.name),
                description:
                  BATTERY_STATUS[
                    declarations.data?.lastError ? "refused" : battery.status
                  ].label,
                disabled: battery.status === "unavailable",
              }))}
            />
          </div>
        )}
        {readOnly && sourceEntry ? (
          <BatteryPolicySourceView
            key={`${sourceEntry}:${focusLine ?? ""}`}
            entry={sourceEntry}
            focusLine={focusLine}
          />
        ) : (
          <RootPolicyForm
            readOnly={readOnly}
            focusLine={focusLine}
            declarations={declarations.data}
          />
        )}
      </TabsContent>
      <TabsContent
        value="effective"
        forceMount={readOnly ? undefined : true}
        className="data-[state=inactive]:hidden"
      >
        <EffectivePolicyView enabled={tab === "effective"} />
      </TabsContent>
    </Tabs>
  );
}

function RootPolicyForm({
  readOnly,
  focusLine,
  declarations,
}: {
  readOnly: boolean;
  focusLine?: number;
  declarations: PolicyDeclarations | null | undefined;
}) {
  const policy = useGuardrailsPolicy();
  const sync = useAppaGithubSync();
  if (policy.isLoading || sync.isPending)
    return <Skeleton className="h-[65vh] w-full" />;
  if (policy.isError || !policy.data || sync.isError)
    return (
      <QueryLoadError
        title="Could not load policy"
        onRetry={() => {
          policy.refetch();
          sync.refetch();
        }}
      />
    );
  return (
    <PolicyForm
      policy={policy.data}
      synced={!!sync.data?.source?.interval}
      readOnly={readOnly}
      focusLine={focusLine}
      declarations={declarations}
    />
  );
}

function PolicyForm({
  policy,
  synced,
  readOnly,
  focusLine,
  declarations,
}: {
  policy: GuardrailsPolicy;
  synced: boolean;
  readOnly: boolean;
  focusLine?: number;
  declarations: PolicyDeclarations | null | undefined;
}) {
  const { data: hasEditPermission } = useHasPermissions({
    toolPolicy: ["update"],
  });
  const canEdit = hasEditPermission && !synced && !readOnly;
  const form = useForm({
    defaultValues: {
      content: policy.content,
      expectedRevision: policy.revision,
    },
  });
  const content = form.watch("content");
  const revision = form.watch("expectedRevision");
  const dirty = form.formState.isDirty;
  const save = useUpdateGuardrailsPolicy();
  const validation = useValidateGuardrailsPolicy();
  const busy = save.isPending || validation.isPending;
  const changedElsewhere = policy.revision !== revision;
  const checked =
    validation.variables === content ? validation.data : undefined;
  const router = useRouter();
  const pendingHrefRef = useRef<string | null>(null);
  useBeforeUnloadWhileDirty(dirty);
  const navigationGuard = useUnsavedChangesGuard({
    isDirty: dirty,
    onOpenChange: (open) => {
      if (open) return;
      const href = pendingHrefRef.current;
      pendingHrefRef.current = null;
      if (href) router.push(href);
    },
  });
  const requestNavigate = useCallback(
    (href: string) => {
      pendingHrefRef.current = href;
      navigationGuard.requestClose();
    },
    [navigationGuard],
  );
  useGuardedInAppNavigation({
    isDirty: dirty,
    onRequestNavigate: requestNavigate,
  });

  useEffect(() => {
    if (!dirty && policy.revision !== form.getValues("expectedRevision"))
      form.reset({
        content: policy.content,
        expectedRevision: policy.revision,
      });
  }, [dirty, policy, form]);
  const submit = form.handleSubmit((values) =>
    save.mutate(values, {
      onSuccess: (saved) => {
        if (saved)
          form.reset({
            content: saved.content,
            expectedRevision: saved.revision,
          });
        validation.reset();
      },
    }),
  );

  return (
    <>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="overflow-hidden rounded-lg border bg-background">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
            <div className="flex items-center gap-3">
              <FileCode2 className="size-4 text-muted-foreground" />
              <div>
                <h2 className="text-sm font-medium">Policy source</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  organization.appa.toml
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Button asChild variant="ghost" size="sm">
                <a
                  href={getDocsUrl(
                    DocsPage.PlatformAiToolGuardrails,
                    "configure-with-the-agent",
                  )}
                  target="_blank"
                  rel="noreferrer"
                >
                  <span>Policy guide</span>
                  <ExternalLink className="size-3.5" />
                </a>
              </Button>
              <output className="text-xs text-muted-foreground">
                {dirty
                  ? "Unsaved changes"
                  : revision === 0
                    ? "Not yet saved"
                    : `Revision ${revision}`}
              </output>
              {!canEdit && (
                <Badge variant="secondary">
                  <LockKeyhole className="mr-1 size-3" />
                  <span>{synced ? "Synced from GitHub" : "Read only"}</span>
                </Badge>
              )}
              {canEdit && (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy || !content.trim()}
                    onClick={() => validation.mutate(content)}
                  >
                    {validation.isPending && (
                      <Loader2 className="size-3.5 animate-spin" />
                    )}
                    <span>Validate</span>
                  </Button>
                  <Button
                    type="submit"
                    size="sm"
                    disabled={
                      busy ||
                      !content.trim() ||
                      checked?.valid === false ||
                      (!dirty && revision > 0)
                    }
                  >
                    {save.isPending ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Save className="size-3.5" />
                    )}
                    <span>Save &amp; apply</span>
                  </Button>
                </>
              )}
            </div>
          </div>
          {checked && (
            <div className="px-4 pt-3">
              <InlineNotice variant={checked.valid ? "neutral" : "error"}>
                {checked.valid && <Check />}
                <InlineNoticeText className="whitespace-pre-wrap font-mono">
                  {checked.valid
                    ? "Policy is valid."
                    : checked.errors.join("\n")}
                </InlineNoticeText>
              </InlineNotice>
            </div>
          )}
          <AnnotatedEditor
            content={content}
            readOnly={!canEdit || save.isPending}
            focusLine={focusLine}
            declarations={
              // The annotations are line numbers into the revision they were read
              // at. An edit moves every line below it, so a dirty buffer gets none.
              !dirty && declarations?.rootRevision === policy.revision
                ? declarations
                : null
            }
            onChange={(value) => {
              form.setValue("content", value, { shouldDirty: true });
              save.reset();
            }}
          />
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t px-4 py-3 text-xs text-muted-foreground">
            <span>
              Saved changes apply to new conversations. Existing conversations
              keep their original policy.
            </span>
            <CompositionSummary declarations={declarations} />
          </div>
        </div>
        {changedElsewhere && dirty && (
          <InlineNotice variant="neutral">
            <InlineNoticeText>
              A newer revision is available. Your edits are preserved. Copy your
              changes before reloading this page to reconcile them.
            </InlineNoticeText>
          </InlineNotice>
        )}
        {checked && checked.warnings.length > 0 && (
          // Its own notice: these entries parse, they just compose to nothing.
          // Folding them into the error strip would read as a refusal to save.
          <InlineNotice variant="neutral" data-testid="policy-warnings">
            <InlineNoticeText className="whitespace-pre-wrap font-mono">
              {checked.warnings.join("\n")}
            </InlineNoticeText>
          </InlineNotice>
        )}
        {save.isError && (
          <InlineNotice variant="error">
            <InlineNoticeText className="whitespace-pre-wrap">
              {save.error.message}
            </InlineNoticeText>
          </InlineNotice>
        )}
      </form>
      <UnsavedChangesDialog
        open={navigationGuard.confirmOpen}
        onKeepEditing={navigationGuard.keepEditing}
        onDiscard={navigationGuard.discardChanges}
      />
    </>
  );
}

/** The policy text with a glyph beside each line the declarations speak for. */
function AnnotatedEditor({
  content,
  readOnly,
  focusLine,
  declarations,
  onChange,
}: {
  content: string;
  readOnly: boolean;
  focusLine?: number;
  declarations: PolicyDeclarations | null;
  onChange: (value: string) => void;
}) {
  const [editor, setEditor] = useState<Parameters<OnMount>[0] | null>(null);
  const decorations = useMemo(
    () =>
      declarations
        ? annotationDecorations(policyAnnotations(declarations))
        : [],
    [declarations],
  );
  useEffect(() => {
    if (!editor) return;
    const collection = editor.createDecorationsCollection(decorations);
    return () => collection.clear();
  }, [editor, decorations]);
  useEffect(() => {
    if (!editor) return;
    return focusPolicyLine(editor, focusLine);
  }, [editor, focusLine]);
  return (
    <Editor
      height="min(50vh, 560px)"
      language="ini"
      value={content}
      onMount={setEditor}
      onChange={(value) => onChange(value ?? "")}
      options={{
        ...POLICY_EDITOR_OPTIONS,
        readOnly,
        ariaLabel: "Organization guardrails policy",
        glyphMargin: true,
      }}
    />
  );
}

/** One line on what the text composes to, beside the editor's own footer. */
function CompositionSummary({
  declarations,
}: {
  declarations: PolicyDeclarations | null | undefined;
}) {
  if (!declarations) return null;
  if (declarations.lastError)
    return (
      <output
        data-testid="composition-summary"
        data-failed="true"
        className="text-destructive"
      >
        Composition failed: not enforced
      </output>
    );
  const total = declarations.batteries.length;
  const notEnforced = declarations.batteries.filter(
    (battery) => battery.status !== "active",
  ).length;
  return (
    <output
      data-testid="composition-summary"
      data-batteries={total}
      data-not-enforced={notEnforced}
    >
      <span>
        {total === 1
          ? "1 battery composes into this policy"
          : `${total} batteries compose into this policy`}
      </span>
      {notEnforced > 0 && <span>{` · ${notEnforced} not enforced`}</span>}
    </output>
  );
}

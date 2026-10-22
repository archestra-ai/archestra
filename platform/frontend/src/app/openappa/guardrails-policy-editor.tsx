"use client";

import { DocsPage, getDocsUrl } from "@archestra/shared";
import type { OnMount } from "@monaco-editor/react";
import { ExternalLink, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Editor } from "@/components/editor";
import { QueryLoadError } from "@/components/query-load-error";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useGuardrailsPolicy } from "@/lib/guardrails-policy.query";
import {
  type PolicyDeclarations,
  useEffectivePolicy,
  usePolicyDeclarations,
} from "@/lib/openappa-batteries.query";
import { batteryDisplayName } from "./_parts/battery-display-name";
import { BatteryPolicySourceView } from "./_parts/battery-policy-source-view";
import { BATTERY_STATUS, batteriesHref } from "./_parts/battery-status";
import {
  batteryWorks,
  compositionNotice,
  compositionOf,
  enforcedStatus,
} from "./_parts/composition-view";
import { EffectivePolicyView } from "./_parts/effective-policy-view";
import { GithubManagedPolicyNotice } from "./_parts/github-managed-policy-notice";
import {
  annotationDecorations,
  focusPolicyLine,
  policyAnnotations,
} from "./_parts/policy-decorations";
import { POLICY_EDITOR_OPTIONS } from "./_parts/policy-editor-options";

export function GuardrailsPolicyEditor({
  sourceEntry,
  focusLine,
}: {
  sourceEntry?: string;
  focusLine?: number;
}) {
  const declarations = usePolicyDeclarations();
  const policy = useGuardrailsPolicy();
  const router = useRouter();
  const [tab, setTab] = useState<"policy" | "effective">("policy");
  const effective = useEffectivePolicy(tab === "effective");
  return (
    <div className="space-y-4">
      {declarations.data?.managedInGithub && <GithubManagedPolicyNotice />}
      <Tabs
        className="gap-0"
        value={tab}
        onValueChange={(next) => setTab(next === "effective" ? next : "policy")}
      >
        {/* The card's header; each view's card below completes it. */}
        <div className="flex flex-wrap items-center gap-3 rounded-t-lg border border-b-0 bg-background px-4 py-2.5">
          <TabsList size="sm" aria-label="Policy view">
            <TabsTrigger value="policy">Source</TabsTrigger>
            <TabsTrigger value="effective">Effective</TabsTrigger>
          </TabsList>
          {tab === "policy" && (
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
              // On phones the picker takes its own full-width row under the
              // view toggle and the guide link, instead of a ragged middle row.
              className="order-last h-8 w-full sm:order-none sm:w-64"
              pinnedItems={[{ value: "root", label: "Organization policy" }]}
              items={(declarations.data?.batteries ?? []).map((battery) => ({
                value: battery.entry,
                label: batteryDisplayName(battery.name),
                description:
                  BATTERY_STATUS[
                    declarations.data
                      ? enforcedStatus(declarations.data, battery)
                      : battery.status
                  ].label,
                disabled: battery.status === "unavailable",
              }))}
            />
          )}
          <div className="ml-auto flex flex-wrap items-center justify-end gap-x-2 gap-y-1 sm:gap-x-3">
            {tab === "effective" ? (
              effective.data &&
              (effective.data.lastError !== null ? (
                <span className="text-xs font-medium">
                  {servedHeading(compositionOf(effective.data))}
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">
                  What the runtime enforces, batteries included.
                </span>
              ))
            ) : sourceEntry ? (
              <>
                <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                  {sourceEntry}
                </span>
                {focusLine && (
                  <span className="text-xs text-muted-foreground">{`Line ${focusLine}`}</span>
                )}
              </>
            ) : (
              <>
                {policy.data && (
                  <output className="text-xs text-muted-foreground">
                    {policy.data.revision === 0
                      ? "Not yet saved"
                      : `Revision ${policy.data.revision}`}
                  </output>
                )}
                {/* Last, so on a phone the bare icon sits on the card's edge
                    above the picker's end rather than floating mid-row. */}
                <Button
                  asChild
                  variant="ghost"
                  size="sm"
                  className="-mr-2 w-8 has-[>svg]:px-0 sm:mr-0 sm:w-auto sm:has-[>svg]:px-2.5"
                >
                  <a
                    href={getDocsUrl(
                      DocsPage.PlatformAiToolGuardrails,
                      "configure-with-the-agent",
                    )}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <span className="sr-only sm:not-sr-only">Policy guide</span>
                    <ExternalLink className="size-3.5" />
                  </a>
                </Button>
              </>
            )}
          </div>
        </div>
        <TabsContent value="policy">
          {sourceEntry ? (
            <BatteryPolicySourceView
              key={`${sourceEntry}:${focusLine ?? ""}`}
              entry={sourceEntry}
              focusLine={focusLine}
            />
          ) : (
            <RootPolicySource
              focusLine={focusLine}
              declarations={declarations.data}
            />
          )}
        </TabsContent>
        <TabsContent value="effective">
          <EffectivePolicyView />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function RootPolicySource({
  focusLine,
  declarations,
}: {
  focusLine?: number;
  declarations: PolicyDeclarations | null | undefined;
}) {
  const policy = useGuardrailsPolicy();
  if (policy.isLoading)
    return <Skeleton className="h-[65vh] w-full rounded-t-none" />;
  if (policy.isError || !policy.data)
    return (
      <QueryLoadError
        title="Could not load policy"
        error={policy.error}
        onRetry={() => policy.refetch()}
      />
    );
  return (
    <div className="overflow-hidden rounded-b-lg border bg-background">
      <AnnotatedEditor
        content={policy.data.content}
        focusLine={focusLine}
        declarations={
          // The annotations are line numbers into the revision they were read at.
          declarations?.rootRevision === policy.data.revision
            ? declarations
            : null
        }
      />
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t px-4 py-3 text-xs text-muted-foreground">
        <span>Conversations follow saved changes.</span>
        <CompositionSummary declarations={declarations} />
      </div>
    </div>
  );
}

/** The policy text with a glyph beside each line the declarations speak for. */
function AnnotatedEditor({
  content,
  focusLine,
  declarations,
}: {
  content: string;
  focusLine?: number;
  declarations: PolicyDeclarations | null;
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
      options={{
        ...POLICY_EDITOR_OPTIONS,
        readOnly: true,
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
  const { served } = compositionOf(declarations);
  if (served.kind === "root_only")
    return (
      <output
        data-testid="composition-summary"
        data-failed="true"
        className="text-destructive"
      >
        Composition failed: nothing is enforced
      </output>
    );
  const total = declarations.batteries.length;
  const notEnforced = declarations.batteries.filter(
    (battery) => !batteryWorks(declarations, battery),
  ).length;
  const stale = served.kind === "previous";
  return (
    <output
      data-testid="composition-summary"
      data-batteries={total}
      data-not-enforced={notEnforced}
      data-stale={stale}
      // Each part keeps to one line and they wrap as wholes, so a phone
      // never strands a separator or splits "1 not enforced".
      className="flex flex-wrap items-center gap-x-3 gap-y-1"
    >
      <span className={stale ? undefined : "whitespace-nowrap"}>
        {stale
          ? `${compositionNotice(declarations)?.title ?? "The latest revision was refused"} · an earlier composition stays enforced`
          : total === 1
            ? "1 battery composes into this policy"
            : `${total} batteries compose into this policy`}
      </span>
      {notEnforced > 0 && (
        // Every included battery with a problem is in the Needs attention group.
        <Link
          href={batteriesHref("attention")}
          className="inline-flex items-center gap-1 whitespace-nowrap font-medium text-destructive underline-offset-2 hover:underline"
        >
          <TriangleAlert className="size-3.5" />
          <span>{notEnforced} not enforced</span>
        </Link>
      )}
    </output>
  );
}

/** What the effective tab says it shows while the latest attempt is refused. */
function servedHeading(composition: PolicyDeclarations["composition"]): string {
  const { served, refusal } = composition;
  if (served.kind === "root_only")
    return "Nothing is enforced: the root text alone";
  if (served.kind === "current" || served.rootRevision === null)
    return "Still enforced: the last composition that opened";
  return served.rootRevision === refusal?.rootRevision
    ? `Still enforced: the earlier composition of revision ${served.rootRevision}`
    : `Still enforced: revision ${served.rootRevision}`;
}

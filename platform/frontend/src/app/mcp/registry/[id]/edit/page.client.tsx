"use client";

import { ArrowLeft, ArrowRight, PackageX } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useRef } from "react";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { PageBackLink } from "@/components/page-back-link";
import { PageLayout } from "@/components/page-layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { WizardFooter } from "@/components/wizard-footer";
import { useInternalMcpCatalog } from "@/lib/mcp/internal-mcp-catalog.query";
import {
  SETUP_STEPS,
  type SetupStepId,
  SetupStepper,
  TestConnectionStep,
  ToolsAndGuardrailsStep,
  useTestConnectionTarget,
} from "../../_parts/catalog-setup-wizard";
import { EditCatalogContent } from "../../_parts/edit-catalog-dialog";
// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { IdleHibernationSection } from "../../_parts/idle-hibernation-section";
// SPDX-SnippetEnd
import type { CatalogItem } from "../../_parts/mcp-server-card";

export function McpCatalogItemEditPage({ id }: { id: string }) {
  const { data: catalogItems, isPending } = useInternalMcpCatalog({});
  const item = catalogItems?.find((catalogItem) => catalogItem.id === id);
  const navigation = useSetupNavigation();

  return (
    <PageLayout
      maxWidth="wizard"
      title={
        item ? (
          <span className="flex min-w-0 items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border bg-muted/40">
              <McpCatalogIcon icon={item.icon} catalogId={item.id} size={24} />
            </span>
            <span className="min-w-0 truncate">Edit {item.name}</span>
            <Badge variant="secondary" className="capitalize font-normal">
              {item.serverType}
            </Badge>
          </span>
        ) : (
          <span>Edit MCP Server</span>
        )
      }
      documentTitle={item ? `Edit ${item.name}` : "Edit MCP Server"}
      description={
        item
          ? "Configure the server, test the connection, review its tools, and set guardrails."
          : undefined
      }
      backLink={
        <PageBackLink href={`/mcp/registry/${id}`}>Back to server</PageBackLink>
      }
      actionButton={
        item ? (
          <SetupStepper
            compact
            activeStep={navigation.step}
            onStepClick={navigation.goToStep}
          />
        ) : undefined
      }
    >
      {isPending ? (
        <div className="space-y-4">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-96 w-full rounded-xl" />
        </div>
      ) : !item ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <PackageX />
            </EmptyMedia>
            <EmptyTitle>Server not found</EmptyTitle>
            <EmptyDescription>
              This MCP server is not in the registry. It may have been removed.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <SetupWizard item={item} navigation={navigation} />
      )}
    </PageLayout>
  );
}

function SetupWizard({
  item,
  navigation,
}: {
  item: CatalogItem;
  navigation: ReturnType<typeof useSetupNavigation>;
}) {
  const router = useRouter();
  const { step, nextStep, prevStep, goToStep } = navigation;

  // Without a connection the test step's own Install button is the step's
  // single CTA — hide the Next button so the two don't compete.
  const { target: testTarget } = useTestConnectionTarget(item);
  const hideNext = step === "test" && !testTarget;

  const detailHref = `/mcp/registry/${item.id}`;
  // Which of the configuration step's two submit buttons asked for the save
  // in flight: "Save" finishes on the server's page (one field changed is one
  // save, not a walk through the remaining steps), "Save & Continue" moves on
  // to the test. Set in the button's click, which runs before the form's
  // submit; Enter in a field clicks the form's first submit button, Save.
  const saveIntentRef = useRef<"finish" | "continue">("continue");

  return (
    <div className="space-y-6">
      {step === "configuration" && (
        <div className="flex flex-col gap-4">
          {/* SPDX-SnippetBegin */}
          {/* SPDX-SnippetCopyrightText: 2026 Archestra Inc. */}
          {/* SPDX-License-Identifier: LicenseRef-Archestra-Enterprise */}
          <IdleHibernationSection item={item} />
          {/* SPDX-SnippetEnd */}
          <EditCatalogContent
            item={item}
            onClose={() => {}}
            keepOpenOnSave
            // A save lands a success toast in the bottom-right corner, exactly
            // where this step's sticky footer sits — so staying here would mean
            // waiting out the toast before the CTA under it could be clicked.
            // Saving is also the point at which this step is done, so move on
            // — or, for a plain Save, back to the server's page.
            onSaved={() => {
              if (saveIntentRef.current === "finish") router.push(detailHref);
              else goToStep("test");
            }}
            // Save is on every step that has something to save: it writes and
            // returns to the server's page — once clean it just returns. The
            // step's own "Save & Continue" stays the primary CTA; Discard is
            // the secondary escape hatch.
            footer={({ isDirty, isSaving, hasBlockingErrors, onReset }) => {
              const savingWith = isSaving ? saveIntentRef.current : null;
              return (
                <WizardFooter>
                  <div>
                    {(isDirty || isSaving) && (
                      <Button
                        variant="outline"
                        type="button"
                        onClick={onReset}
                        disabled={isSaving}
                      >
                        Discard changes
                      </Button>
                    )}
                  </div>
                  {/* The form clears its dirty state as soon as the save is
                      submitted, so `isSaving` has to be checked first —
                      otherwise the buttons flip to their clean faces
                      mid-save. */}
                  <div className="flex items-center gap-2">
                    {savingWith === "finish" ? (
                      <Button type="submit" variant="outline" disabled>
                        <span>Saving...</span>
                      </Button>
                    ) : isDirty || isSaving ? (
                      <Button
                        type="submit"
                        variant="outline"
                        disabled={hasBlockingErrors || isSaving}
                        onClick={() => {
                          saveIntentRef.current = "finish";
                        }}
                      >
                        Save
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => router.push(detailHref)}
                      >
                        Save
                      </Button>
                    )}
                    {savingWith === "continue" ? (
                      <Button type="submit" disabled>
                        <span>Saving...</span>
                      </Button>
                    ) : isDirty || isSaving ? (
                      <Button
                        type="submit"
                        disabled={hasBlockingErrors || isSaving}
                        onClick={() => {
                          saveIntentRef.current = "continue";
                        }}
                      >
                        <span>Save & Continue</span>
                        <ArrowRight className="h-4 w-4" />
                      </Button>
                    ) : (
                      <Button type="button" onClick={() => goToStep("test")}>
                        <span>Test Connection</span>
                        <ArrowRight className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </WizardFooter>
              );
            }}
          />
        </div>
      )}

      {step === "test" && <TestConnectionStep item={item} />}

      {step === "tools" && <ToolsAndGuardrailsStep item={item} />}

      {/* The configuration step carries its CTA inside the form footer. */}
      {step !== "configuration" && (
        <WizardFooter>
          <div>
            {prevStep && (
              <Button variant="outline" onClick={() => goToStep(prevStep.id)}>
                <ArrowLeft className="h-4 w-4" />
                {prevStep.title}
              </Button>
            )}
          </div>
          {nextStep ? (
            !hideNext && (
              <Button onClick={() => goToStep(nextStep.id)}>
                {nextStep.title}
                <ArrowRight className="h-4 w-4" />
              </Button>
            )
          ) : (
            <Button onClick={() => router.push(detailHref)}>Finish</Button>
          )}
        </WizardFooter>
      )}
    </div>
  );
}

function useSetupNavigation() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const stepParam = searchParams.get("step");
  const step: SetupStepId = SETUP_STEPS.some(
    (candidate) => candidate.id === stepParam,
  )
    ? (stepParam as SetupStepId)
    : stepParam === "guardrails"
      ? "tools"
      : "configuration";
  const stepIndex = SETUP_STEPS.findIndex((candidate) => candidate.id === step);

  return {
    step,
    nextStep: SETUP_STEPS[stepIndex + 1],
    prevStep: SETUP_STEPS[stepIndex - 1],
    goToStep: (target: SetupStepId) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("step", target);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
  };
}

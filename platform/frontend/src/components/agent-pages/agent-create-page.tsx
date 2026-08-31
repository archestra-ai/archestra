"use client";

import { E2eTestId } from "@archestra/shared";
import { ArrowLeft, ArrowRight, CircleCheck, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AgentForm } from "@/components/agent-form";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  UnsavedChangesDialog,
  useBeforeUnloadWhileDirty,
  useUnsavedChangesGuard,
} from "@/components/unsaved-changes-guard";
import { WizardFooter } from "@/components/wizard-footer";
import { WizardStepper } from "@/components/wizard-stepper";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { AgentCatalog, type AgentCatalogTemplate } from "./agent-catalog";
import {
  AGENT_PAGE_CONFIGS,
  type AgentPageKind,
  type AgentSetupStepId,
  agentDetailHref,
  agentListHref,
  getAgentSetupSteps,
} from "./agent-page-config";
import { AgentPageShell } from "./agent-page-shell";

/**
 * `/<family>/new` — the setup wizard for a record that does not exist yet.
 * Every step fills one form that lives for the whole wizard; nothing reaches
 * the backend until the last step's Create, which writes the record and
 * everything picked for it together, then lands on the detail page's Connect
 * section — the way the skills wizard collects a draft and creates at the end.
 */
export function AgentCreatePage({ kind }: { kind: AgentPageKind }) {
  const config = AGENT_PAGE_CONFIGS[kind];
  const router = useRouter();
  const backgroundExecutionEnabled = useFeature("agentBackgroundExecution");
  const catalogEnabled =
    kind === "agent" && backgroundExecutionEnabled === true;
  const [sourceSelected, setSourceSelected] = useState(false);
  const [selectedTemplate, setSelectedTemplate] =
    useState<AgentCatalogTemplate | null>(null);
  const steps = getAgentSetupSteps({ agentType: kind, builtIn: false });
  const [step, setStep] = useState<AgentSetupStepId>(steps[0].id);
  const stepIndex = steps.findIndex((s) => s.id === step);
  const prevStep = steps[stepIndex - 1];
  const nextStep = steps[stepIndex + 1];
  const goToStep = (target: AgentSetupStepId) => {
    setStep(target);
    // A new step starts at its top, as a routed step would.
    window.scrollTo({ top: 0 });
  };

  // A create-only role has nowhere to go afterwards: the detail page needs
  // `read`. Such a user is told the record exists instead of being bounced
  // into a not-found page.
  const { data: canReadFamily, isPending: isReadPermissionPending } =
    useHasPermissions({ [config.resource]: ["read"] });
  const [created, setCreated] = useState<{ id: string; name: string } | null>(
    null,
  );

  // Where a create goes is not decided until the read permission is known, and
  // the answer can still be in flight when the record lands. The created id
  // waits here and the decision is taken once, when the permission settles —
  // pushing on a pending `undefined` would send a create-only role to a page
  // it cannot read.
  const isReadPermissionKnown = !isReadPermissionPending;
  const showsUnreadableSuccess =
    !!created && isReadPermissionKnown && !canReadFamily;
  useEffect(() => {
    if (!created || !isReadPermissionKnown || !canReadFamily) return;
    // Created: the next thing to do with it is connect something to it.
    router.push(agentDetailHref(kind, created.id, "connect"));
  }, [created, isReadPermissionKnown, canReadFamily, router, kind]);

  const [isDirty, setIsDirty] = useState(false);
  useBeforeUnloadWhileDirty(isDirty);
  const leave = useCallback(
    (open: boolean) => {
      if (!open) router.push(agentListHref(kind));
    },
    [router, kind],
  );
  // Same dirty check the modal used to run on close, now guarding Cancel and
  // the back link.
  const guard = useUnsavedChangesGuard({ isDirty, onOpenChange: leave });
  const isChoosingSource = catalogEnabled && !sourceSelected;
  const header = {
    title: `Create ${config.singular}`,
    description: isChoosingSource
      ? "Choose a maintained Agent template or start from scratch."
      : selectedTemplate
        ? `${selectedTemplate.name} is prefilled below. Review or change any setting before creating it.`
        : config.createDescription,
    action:
      !isChoosingSource && steps.length > 1 ? (
        <div className="hidden sm:block">
          <WizardStepper
            compact
            steps={steps}
            activeStep={step}
            // Earlier steps can be revisited; a later one is reached through
            // its predecessor's Next, which is what checks the step is
            // complete.
            onStepClick={(target) => {
              const targetIndex = steps.findIndex((s) => s.id === target);
              if (targetIndex < stepIndex) goToStep(target);
            }}
            stepTestIdPrefix={E2eTestId.AgentSetupStep}
          />
        </div>
      ) : undefined,
  };

  return (
    <AgentPageShell
      // The list needs the same read permission this role is missing, so on
      // the success state there is nowhere to go back to.
      backHref={showsUnreadableSuccess ? undefined : agentListHref(kind)}
      backLabel={config.plural}
      onBackRequest={guard.requestClose}
      header={header}
    >
      {showsUnreadableSuccess ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CircleCheck />
            </EmptyMedia>
            <EmptyTitle>{config.singular} created</EmptyTitle>
            <EmptyDescription>
              <span>
                &quot;{created.name}&quot; was created. You do not have
                permission to view it.
              </span>
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : created ? (
        // Created, and on its way to the Connect section as soon as the read
        // permission answers. The form stays unmounted so it cannot be
        // submitted a second time.
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Loader2 className="animate-spin" />
            </EmptyMedia>
            <EmptyTitle>{config.singular} created</EmptyTitle>
            <EmptyDescription>
              Opening &quot;{created.name}&quot;…
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : isChoosingSource ? (
        <AgentCatalog
          onStartFromScratch={() => {
            setSelectedTemplate(null);
            setSourceSelected(true);
          }}
          onSelect={(template) => {
            setSelectedTemplate(template);
            setSourceSelected(true);
          }}
        />
      ) : (
        <AgentForm
          agentType={kind}
          defaultIconType={config.defaultIconType}
          initialValues={selectedTemplate?.initialValues}
          // One mount for the whole wizard: the steps show one group at a
          // time, and what was picked on a step stays on the form until the
          // create at the end.
          activeSection={step}
          submitEnabled={!nextStep}
          onDirtyChange={setIsDirty}
          onCreated={(record) => {
            // The record is saved: nothing is unsaved any more, whichever
            // way the effect above decides to leave.
            setIsDirty(false);
            setCreated(record);
          }}
          footer={({ isSaving, canSubmit }) => (
            <WizardFooter>
              <div>
                {prevStep ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={isSaving}
                    onClick={() => goToStep(prevStep.id)}
                  >
                    <ArrowLeft className="h-4 w-4" />
                    <span>{prevStep.title}</span>
                  </Button>
                ) : catalogEnabled ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setSelectedTemplate(null);
                      setSourceSelected(false);
                      setStep(steps[0].id);
                    }}
                    disabled={isSaving}
                  >
                    <ArrowLeft className="h-4 w-4" />
                    Catalog
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={guard.requestClose}
                    disabled={isSaving}
                  >
                    Cancel
                  </Button>
                )}
              </div>
              {nextStep ? (
                // Moving on needs what a create would need of this step (a
                // name, a complete visibility choice), so the last step is
                // never reached with a record that cannot be created.
                //
                // Keyed apart from the Create button, and with the default
                // action stopped: the step change re-renders this slot as
                // the submit button while the click is still dispatching,
                // and a reused DOM button would then submit the form.
                <Button
                  key="next"
                  type="button"
                  disabled={!canSubmit}
                  onClick={(event) => {
                    event.preventDefault();
                    goToStep(nextStep.id);
                  }}
                  data-testid={E2eTestId.AgentSetupNextButton}
                >
                  <span>{nextStep.title}</span>
                  <ArrowRight className="h-4 w-4" />
                </Button>
              ) : (
                <Button
                  key="create"
                  type="submit"
                  disabled={!canSubmit}
                  data-testid={E2eTestId.AgentSetupSubmitButton}
                >
                  {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
                  <span>
                    {isSaving ? "Creating..." : `Create ${config.singular}`}
                  </span>
                </Button>
              )}
            </WizardFooter>
          )}
        />
      )}

      <UnsavedChangesDialog
        open={guard.confirmOpen}
        onKeepEditing={guard.keepEditing}
        onDiscard={guard.discardChanges}
      />
    </AgentPageShell>
  );
}

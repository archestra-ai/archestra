"use client";

import { DocsPage, E2eTestId, getDocsUrl } from "@archestra/shared";
import {
  ArrowLeft,
  ArrowRight,
  Info,
  Loader2,
  PackageX,
  TriangleAlert,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { AgentBadge } from "@/components/agent-badge";
import { AgentForm } from "@/components/agent-form";
import { AgentIcon } from "@/components/agent-icon";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { QueryLoadError } from "@/components/query-load-error";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import {
  UnsavedChangesDialog,
  useBeforeUnloadWhileDirty,
  useUnsavedChangesGuard,
} from "@/components/unsaved-changes-guard";
import { WizardFooter } from "@/components/wizard-footer";
import { WizardStepper } from "@/components/wizard-stepper";
import { useProfile } from "@/lib/agent.query";
import {
  AGENT_PAGE_CONFIGS,
  type AgentPageKind,
  type AgentSetupStepId,
  agentDetailHref,
  agentEditHref,
  agentPageKindForType,
  getAgentSetupSteps,
  isAgentTypeAllowedOnPage,
  resolveAgentSetupStep,
} from "./agent-page-config";
import { AgentPageShell } from "./agent-page-shell";
import { useAgentAccess } from "./use-agent-access";

/**
 * `/<family>/[id]/edit` — the setup wizard on an existing record, URL-driven
 * by `?step=`. Each step saves on its own: "Save" on every step writes it
 * and returns to the detail page's Overview (one field changed is one save,
 * not a walk through the remaining steps), "Save & Continue" writes it and
 * moves on. Reached from the detail page's Edit action and from every "edit
 * this agent" deep link in the app.
 */
export function AgentEditPage({
  kind,
  id,
}: {
  kind: AgentPageKind;
  id: string;
}) {
  const config = AGENT_PAGE_CONFIGS[kind];
  const router = useRouter();
  const { data: agent, isPending, isError, refetch } = useProfile(id);

  // Hold the last record this mount saw. Deleting the agent in another tab (or
  // any background refetch that answers 404) turns `data` into null, and
  // dropping the wizard on that would throw away whatever the user has typed
  // since. The wizard stays up on the held copy and says the record is gone.
  const heldAgentRef = useRef<Agent | null>(null);
  if (agent) heldAgentRef.current = agent;
  const heldAgent = agent ?? heldAgentRef.current;
  // A successful null after we had a record — not a failed request, which
  // leaves the previous data in place.
  const isGone = !agent && !!heldAgentRef.current;

  // An id of another family under this family's route: hand it to its own
  // pages rather than editing a proxy under the gateway header.
  useEffect(() => {
    if (agent && !isAgentTypeAllowedOnPage(kind, agent.agentType)) {
      router.replace(agentEditHref(agentPageKindForType(agent.agentType), id));
    }
  }, [agent, kind, id, router]);

  // The wizard renders its own shell: its back link runs through the
  // unsaved-changes guard, which lives with the form's dirty state.
  if (heldAgent)
    return <SetupWizard kind={kind} agent={heldAgent} isGone={isGone} />;

  const unloadedHeader = {
    title: `Edit ${config.singular}`,
    description: config.editDescription,
  };

  return (
    <AgentPageShell
      backHref={config.basePath}
      backLabel={config.plural}
      header={unloadedHeader}
    >
      {isPending ? (
        <Skeleton className="h-96 w-full rounded-xl" />
      ) : isError ? (
        // The request failed rather than answering "no such record": offer a
        // retry instead of telling the user their agent does not exist.
        <QueryLoadError
          className="border"
          title={`Couldn't load this ${config.singularInSentence}`}
          onRetry={() => refetch()}
        />
      ) : (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <PackageX />
            </EmptyMedia>
            <EmptyTitle>{config.singular} not found</EmptyTitle>
            <EmptyDescription>
              This {config.singularInSentence} does not exist or is not visible
              to you. It may have been removed.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </AgentPageShell>
  );
}

type Agent = NonNullable<ReturnType<typeof useProfile>["data"]>;

function SetupWizard({
  kind,
  agent,
  isGone,
}: {
  kind: AgentPageKind;
  agent: Agent;
  /** The record has since been deleted; this is the last copy we hold. */
  isGone: boolean;
}) {
  const config = AGENT_PAGE_CONFIGS[kind];
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { canEdit, isBuiltIn } = useAgentAccess(agent, kind);

  const steps = getAgentSetupSteps({
    agentType: agent.agentType,
    builtIn: isBuiltIn,
  });
  const stepParam = searchParams.get("step");
  const step = resolveAgentSetupStep(steps, stepParam);
  const stepIndex = steps.findIndex((s) => s.id === step);
  const prevStep = steps[stepIndex - 1];
  const nextStep = steps[stepIndex + 1];
  const detailHref = agentDetailHref(kind, agent.id);

  // Unsaved edits on a form step guard every way out that is not a save:
  // another step, Cancel, the back link's sibling controls. The pending
  // destination is parked here and taken once the guard lets go.
  const [isDirty, setIsDirty] = useState(false);
  useBeforeUnloadWhileDirty(isDirty);
  // Which of the two submit buttons asked for the save in flight: "Save"
  // finishes on the Overview, "Save & Continue" moves to the next step. Set
  // in the button's click, which runs before the form's submit; Enter in a
  // field clicks the form's first submit button, Save, so it finishes too.
  const saveIntentRef = useRef<"finish" | "continue">("continue");
  const pendingHrefRef = useRef<string | null>(null);
  const navigate = useCallback(
    (href: string, { replace = false } = {}) => {
      if (replace) router.replace(href, { scroll: false });
      else router.push(href);
    },
    [router],
  );
  const guard = useUnsavedChangesGuard({
    isDirty,
    onOpenChange: (open) => {
      if (open) return;
      const href = pendingHrefRef.current;
      pendingHrefRef.current = null;
      if (href) navigate(href, { replace: href.startsWith(pathname) });
    },
  });
  const requestNavigate = useCallback(
    (href: string) => {
      pendingHrefRef.current = href;
      guard.requestClose();
    },
    [guard],
  );
  const stepHref = (target: AgentSetupStepId) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("step", target);
    return `${pathname}?${params.toString()}`;
  };
  const goToStep = (target: AgentSetupStepId, { force = false } = {}) => {
    const href = stepHref(target);
    if (force) navigate(href, { replace: true });
    else requestNavigate(href);
  };

  // A `?step=` this record has no step for (a proxy sent to `?step=tools`, or
  // a typo) silently resolves to the first step. Correct the URL to match, so
  // a reload, a copied link or the back button does not keep asking for a step
  // that is not on this wizard.
  useEffect(() => {
    if (!stepParam || stepParam === step) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set("step", step);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }, [stepParam, step, searchParams, pathname, router]);

  // `?openTools=true` (from "add tools to this gateway" links) pops the tools
  // picker open on the tools step. "All" gateways hide the tool editor (there
  // is nothing to pick), so only Custom ones get the auto-open.
  const openToolsCombobox =
    step === "tools" &&
    searchParams.get("openTools") === "true" &&
    !agent.accessAllTools;

  const formAgentType = agent.agentType === "profile" ? "profile" : kind;
  const wizardHeader = {
    title: (
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border bg-muted/40">
          <AgentIcon
            icon={agent.icon}
            fallbackType={config.defaultIconType}
            size={24}
          />
        </div>
        <span className="min-w-0 truncate">Edit {agent.name}</span>
        <AgentBadge
          type={isBuiltIn ? "builtIn" : agent.scope}
          className="font-normal"
        />
      </div>
    ),
    description:
      isBuiltIn && agent.description ? (
        <>
          {agent.description.replace(/\.?$/, ".")}{" "}
          <ExternalDocsLink
            href={getDocsUrl(DocsPage.PlatformBuiltInSubagents)}
            className="underline"
            showIcon={false}
          >
            Learn more
          </ExternalDocsLink>
        </>
      ) : (
        (agent.description ?? "")
      ),
    action:
      steps.length > 1 ? (
        <div className="block">
          <WizardStepper
            compact
            steps={steps}
            activeStep={step}
            onStepClick={(target) => {
              if (target !== step) goToStep(target);
            }}
            stepTestIdPrefix={E2eTestId.AgentSetupStep}
          />
        </div>
      ) : undefined,
  };

  return (
    <AgentPageShell
      backHref={detailHref}
      backLabel={`Back to ${config.singularInSentence}`}
      onBackRequest={() => requestNavigate(detailHref)}
      header={wizardHeader}
    >
      <div className="space-y-6">
        {isGone ? (
          <Alert variant="destructive">
            <TriangleAlert className="h-4 w-4" />
            <AlertDescription>
              This {config.singularInSentence} is no longer available — it was
              deleted while you were editing it. Your unsaved changes cannot be
              saved; copy anything you need before leaving.
            </AlertDescription>
          </Alert>
        ) : (
          !canEdit && (
            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription>
                You can view this {config.singularInSentence}&apos;s
                configuration but not change it.
              </AlertDescription>
            </Alert>
          )
        )}

        <AgentForm
          // A fresh mount per agent and per step: the form seeds several sets
          // from per-agent reads and would otherwise carry one step's pending
          // state into the next.
          key={`${agent.id}:${step}`}
          agent={agent}
          agentType={formAgentType}
          defaultIconType={config.defaultIconType}
          sections={[step]}
          readOnly={!canEdit}
          openToolsCombobox={openToolsCombobox}
          onDirtyChange={setIsDirty}
          onSaved={() => {
            if (saveIntentRef.current === "continue" && nextStep) {
              goToStep(nextStep.id, { force: true });
            } else {
              navigate(detailHref);
            }
          }}
          footer={({ isSaving, isDirty: formDirty, canSubmit }) => {
            // Nothing to save onto once the record is gone; the PUT would
            // only come back 404.
            const canSave = canSubmit && !isGone;
            const savingWith = isSaving ? saveIntentRef.current : null;
            return (
              <WizardFooter>
                <div className="flex [&>button]:w-full sm:[&>button]:w-auto">
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
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={isSaving}
                      onClick={() => requestNavigate(detailHref)}
                    >
                      Cancel
                    </Button>
                  )}
                </div>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center [&>button]:w-full sm:[&>button]:w-auto">
                  {/* Save is on every step: it writes the step and returns to
                      the Overview — once clean it just returns. On the last
                      step it is the one action; before it, the step's own
                      "Save & Continue" stays the primary one. `isSaving` is
                      checked before `formDirty`: the form clears its dirty
                      state as the save is submitted, and the buttons must
                      not flip to their clean faces mid-save. */}
                  {savingWith === "finish" ? (
                    <Button
                      type="submit"
                      variant={nextStep ? "outline" : "default"}
                      disabled
                    >
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>Saving...</span>
                    </Button>
                  ) : formDirty || isSaving ? (
                    <Button
                      type="submit"
                      variant={nextStep ? "outline" : "default"}
                      disabled={!canSave || isSaving}
                      onClick={() => {
                        saveIntentRef.current = "finish";
                      }}
                      data-testid={E2eTestId.AgentSetupSubmitButton}
                    >
                      Save
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant={nextStep ? "outline" : "default"}
                      onClick={() => navigate(detailHref)}
                      data-testid={E2eTestId.AgentSetupFinishButton}
                    >
                      Save
                    </Button>
                  )}
                  {nextStep &&
                    (savingWith === "continue" ? (
                      <Button type="submit" disabled>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>Saving...</span>
                      </Button>
                    ) : formDirty || isSaving ? (
                      <Button
                        type="submit"
                        disabled={!canSave || isSaving}
                        onClick={() => {
                          saveIntentRef.current = "continue";
                        }}
                        data-testid={E2eTestId.AgentSetupNextButton}
                      >
                        <span>Save & Continue</span>
                        <ArrowRight className="h-4 w-4" />
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        onClick={() => goToStep(nextStep.id)}
                        data-testid={E2eTestId.AgentSetupNextButton}
                      >
                        <span>{nextStep.title}</span>
                        <ArrowRight className="h-4 w-4" />
                      </Button>
                    ))}
                </div>
              </WizardFooter>
            );
          }}
        />

        <UnsavedChangesDialog
          open={guard.confirmOpen}
          onKeepEditing={guard.keepEditing}
          onDiscard={guard.discardChanges}
        />
      </div>
    </AgentPageShell>
  );
}

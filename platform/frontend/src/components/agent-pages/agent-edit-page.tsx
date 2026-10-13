"use client";

import { E2eTestId } from "@archestra/shared";
import { ArrowLeft, ArrowRight, Info, Loader2, PackageX } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AgentForm, type AgentFormSection } from "@/components/agent-form";
import { QueryLoadError } from "@/components/query-load-error";
import { ResourcePermissions } from "@/components/resource-permissions";
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
  useGuardedInAppNavigation,
  useUnsavedChangesGuard,
} from "@/components/unsaved-changes-guard";
import { WizardFooter } from "@/components/wizard-footer";
import { WizardStepper } from "@/components/wizard-stepper";
import { useProfile } from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { notYoursToChange } from "@/lib/design/resource-lexicon";
import { cn } from "@/lib/utils/tailwind";
import {
  AGENT_PAGE_CONFIGS,
  type AgentSetupStepId,
  agentConfigureHref,
  agentDetailHref,
  agentEditHref,
  agentPageKindForType,
  getAgentSetupSteps,
  isAgentTypeAllowedOnPage,
} from "./agent-page-config";
import { AgentPageShell } from "./agent-page-shell";
import { useAgentAccess } from "./use-agent-access";

/**
 * `/agents/[id]/edit` — an agent's configuration, in the same steps it was
 * created in. Every step is reachable at once and all of them live on one
 * form mount, so an edit made on one step survives a visit to another and a
 * single Save writes them together. Save works from any step: nobody has to
 * walk the rest to change a name.
 */
export function AgentEditPage({ id }: { id: string }) {
  const config = AGENT_PAGE_CONFIGS.agent;
  const router = useRouter();
  const { data: agent, isPending, isError, refetch } = useProfile(id);

  useEffect(() => {
    if (agent && !isAgentTypeAllowedOnPage("agent", agent.agentType)) {
      router.replace(
        agentConfigureHref(agentPageKindForType(agent.agentType), id),
      );
    }
  }, [agent, id, router]);

  if (agent) return <AgentEditor agent={agent} />;

  const shell = (children: React.ReactNode) => (
    <AgentPageShell
      backHref={agentDetailHref("agent", id)}
      backLabel={config.singular}
      header={{ title: `Edit ${config.singularInSentence}` }}
    >
      {children}
    </AgentPageShell>
  );
  if (isPending) return shell(<Skeleton className="h-96 w-full rounded-xl" />);
  if (isError) {
    return shell(
      <QueryLoadError
        className="border"
        title={`Couldn't load this ${config.singularInSentence}`}
        onRetry={() => refetch()}
      />,
    );
  }
  return shell(
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <PackageX />
        </EmptyMedia>
        <EmptyTitle>{config.singular} not found</EmptyTitle>
        <EmptyDescription>
          This {config.singularInSentence} does not exist or is not visible to
          you. It may have been removed.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>,
  );
}

type Agent = NonNullable<ReturnType<typeof useProfile>["data"]>;

function AgentEditor({ agent }: { agent: Agent }) {
  const config = AGENT_PAGE_CONFIGS.agent;
  const router = useRouter();
  const searchParams = useSearchParams();
  const runtimeEnabled = useFeature("agentRuntime") === true;
  const {
    canEdit,
    isBuiltIn,
    isPending: isAccessPending,
  } = useAgentAccess(agent, "agent");
  // The channel editor reads the org's channel bindings, so the step only
  // exists for a reader who may see them.
  const { data: canReadAgentTriggers } = useHasPermissions({
    organizationSettings: ["read"],
  });
  const steps = getAgentSetupSteps({
    agentType: agent.agentType,
    builtIn: isBuiltIn,
  }).filter((entry) => entry.id !== "messaging" || !!canReadAgentTriggers);
  const stepParam = searchParams.get("step");
  const step = steps.find((entry) => entry.id === stepParam)?.id ?? steps[0].id;
  const stepIndex = steps.findIndex((entry) => entry.id === step);
  const prevStep = steps[stepIndex - 1];
  const nextStep = steps[stepIndex + 1];
  // The runtime's settings are part of what the agent is, so they sit on
  // Configuration with the rest of it rather than on a step of their own.
  const groupsForStep = (id: AgentSetupStepId): AgentFormSection[] =>
    id === "configuration"
      ? [
          "configuration",
          ...(runtimeEnabled && !isBuiltIn ? (["runtime"] as const) : []),
        ]
      : [id];
  const mountedGroups = steps.flatMap((entry) => groupsForStep(entry.id));
  const showPermissions = !isBuiltIn;
  const permissionResource =
    agent.agentType === "mcp_gateway" ? "mcpGateway" : "agent";
  const overviewHref = agentDetailHref("agent", agent.id);

  const [formDirty, setFormDirty] = useState(false);
  const [permissionsDirty, setPermissionsDirty] = useState(false);
  const isDirty = formDirty || permissionsDirty;
  useBeforeUnloadWhileDirty(isDirty);
  // The permissions block saves through the form's own footer, so one
  // "Save changes" covers both.
  const savePermissionsRef = useRef<(() => Promise<void>) | null>(null);
  const registerPermissionsSave = useCallback(
    (save: (() => Promise<void>) | null) => {
      savePermissionsRef.current = save;
    },
    [],
  );
  const [savingPermissions, setSavingPermissions] = useState(false);
  const savePermissions = useCallback(async () => {
    const save = savePermissionsRef.current;
    if (!save) return;
    setSavingPermissions(true);
    try {
      await save();
    } finally {
      setSavingPermissions(false);
    }
  }, []);
  const [footerSlot, setFooterSlot] = useState<HTMLDivElement | null>(null);

  const pendingHrefRef = useRef<string | null>(null);
  const guard = useUnsavedChangesGuard({
    isDirty,
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
      guard.requestClose();
    },
    [guard],
  );
  useGuardedInAppNavigation({ isDirty, onRequestNavigate: requestNavigate });

  // A step change is the same mount under another query, so nothing unsaved
  // is at risk and it replaces rather than stacking history per step.
  const goToStep = (id: AgentSetupStepId) => {
    const carried = new URLSearchParams(searchParams.toString());
    carried.delete("step");
    const rest = carried.toString();
    const href = agentEditHref(agent.id, id);
    router.replace(
      rest ? `${href}${href.includes("?") ? "&" : "?"}${rest}` : href,
      { scroll: false },
    );
    document
      .querySelector("[data-page-header]")
      ?.scrollIntoView?.({ block: "start" });
  };

  return (
    <AgentPageShell
      stickyFooter
      backHref={overviewHref}
      backLabel={agent.name}
      onBackRequest={() => requestNavigate(overviewHref)}
      header={{
        // One line beside the progress bar: a long name truncates rather
        // than wrapping under it.
        title: (
          <span className="block min-w-0 truncate" title={`Edit ${agent.name}`}>
            Edit {agent.name}
          </span>
        ),
        documentTitle: `Edit ${agent.name}`,
        action:
          steps.length > 1 ? (
            <WizardStepper
              variant="progress"
              allReached
              steps={steps}
              activeStep={step}
              onStepClick={goToStep}
              stepTestIdPrefix={E2eTestId.AgentSetupStep}
            />
          ) : undefined,
      }}
    >
      <div className="space-y-4">
        {!canEdit && !isAccessPending && (
          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription>
              You can view this {config.singularInSentence}&apos;s configuration
              but not change it.{" "}
              {notYoursToChange({ resource: "agent", scope: agent.scope })}.
            </AlertDescription>
          </Alert>
        )}
        <AgentForm
          key={agent.id}
          agent={agent}
          agentType="agent"
          defaultIconType={config.defaultIconType}
          sections={mountedGroups}
          activeSection={groupsForStep(step)}
          readOnly={!canEdit}
          openToolsCombobox={
            step === "tools" &&
            searchParams.get("openTools") === "true" &&
            !agent.accessAllTools
          }
          onDirtyChange={setFormDirty}
          // The form saves first; its grants follow once it has.
          onSaved={showPermissions ? () => void savePermissions() : undefined}
          footer={({
            formId,
            isSaving: formSaving,
            isDirty: fieldsDirty,
            canSubmit,
            readOnly,
          }) => {
            const isSaving = formSaving || savingPermissions;
            const row = (
              <WizardFooter>
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
                  {prevStep && (
                    <Button
                      size="sm"
                      type="button"
                      variant="outline"
                      disabled={isSaving}
                      onClick={() => goToStep(prevStep.id)}
                    >
                      <ArrowLeft className="h-4 w-4" />
                      <span>{prevStep.title}</span>
                    </Button>
                  )}
                  {!readOnly && (
                    <span className="text-xs text-muted-foreground">
                      {isDirty
                        ? "Unsaved changes. Save any time, there is no need to visit the other steps."
                        : "No changes yet."}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    type="button"
                    variant="outline"
                    disabled={isSaving}
                    onClick={() => requestNavigate(overviewHref)}
                  >
                    {readOnly ? "Close" : "Cancel"}
                  </Button>
                  {nextStep && (
                    // Keyed apart from Save and with the default action
                    // stopped, so a click that re-renders this slot never
                    // lands on the submit button.
                    <Button
                      size="sm"
                      key="next"
                      type="button"
                      variant="outline"
                      onClick={(event) => {
                        event.preventDefault();
                        goToStep(nextStep.id);
                      }}
                      data-testid={E2eTestId.AgentSetupNextButton}
                    >
                      <span>{nextStep.title}</span>
                      <ArrowRight className="h-4 w-4" />
                    </Button>
                  )}
                  {!readOnly && (
                    <Button
                      size="sm"
                      key="save"
                      // With only the grants changed there is no form to
                      // submit, so the button saves them directly.
                      type={fieldsDirty ? "submit" : "button"}
                      form={fieldsDirty ? formId : undefined}
                      onClick={
                        fieldsDirty ? undefined : () => void savePermissions()
                      }
                      disabled={
                        isSaving ||
                        (fieldsDirty ? !canSubmit : !permissionsDirty)
                      }
                      data-testid={E2eTestId.AgentSetupSubmitButton}
                    >
                      {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
                      <span>{isSaving ? "Saving..." : "Save changes"}</span>
                    </Button>
                  )}
                </div>
              </WizardFooter>
            );
            return footerSlot ? createPortal(row, footerSlot) : null;
          }}
        />
        {showPermissions && (
          // Mounted on every step so its edits survive a step change; shown
          // on Configuration, where who can use the agent belongs.
          <div className={cn("-mt-6", step !== "configuration" && "hidden")}>
            <ResourcePermissions
              embedded
              standalone
              resource={permissionResource}
              scope={agent.id}
              onDirtyChange={setPermissionsDirty}
              registerSave={registerPermissionsSave}
              lockedReason={
                agent.isPersonalGateway
                  ? "A personal MCP gateway is only for its owner."
                  : undefined
              }
            />
          </div>
        )}
        {/* The slot, not the row inside it, sticks: a sticky element only
            sticks within its parent, and the row's parent is this. */}
        <div ref={setFooterSlot} className="sm:sticky sm:bottom-0 sm:z-10" />
      </div>
      <UnsavedChangesDialog
        open={guard.confirmOpen}
        onKeepEditing={() => {
          pendingHrefRef.current = null;
          guard.keepEditing();
        }}
        onDiscard={guard.discardChanges}
      />
    </AgentPageShell>
  );
}

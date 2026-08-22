"use client";

import type { ResourceVisibilityScope } from "@archestra/shared";
import { ArrowLeft, ArrowRight, Info } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageLayout } from "@/components/page-layout";
import { QueryLoadError } from "@/components/query-load-error";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  UnsavedChangesDialog,
  useBeforeUnloadWhileDirty,
  useUnsavedChangesGuard,
} from "@/components/unsaved-changes-guard";
import { WizardFooter } from "@/components/wizard-footer";
import { WizardStepper } from "@/components/wizard-stepper";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import {
  type PluginDetail,
  usePlugin,
  useUpdatePlugin,
} from "@/lib/plugins/plugin.query";
import { cn } from "@/lib/utils";
import {
  PluginContentFields,
  type PluginFileDraft,
} from "../../_parts/plugin-content-fields";
import {
  PLUGIN_EDIT_STEPS,
  type PluginEditStepId,
  pluginDetailHref,
  resolvePluginEditStep,
} from "../../_parts/plugin-page-config";
import {
  PluginBackLink,
  PluginNotFound,
  PluginPageLoading,
} from "../../_parts/plugin-page-shell";
import type { PluginPlatform } from "../../_parts/plugin-platforms";
import { PluginScopeSelector } from "../../_parts/plugin-scope-selector";

const STEP_DESCRIPTIONS: Record<PluginEditStepId, string> = {
  content:
    "Edit the plugin's metadata and payload files. GitHub-sourced bytes stay read-only.",
  access: "Choose who can discover and install the plugin.",
};

interface PluginDraft {
  displayName: string;
  description: string;
  enabled: boolean;
  supportedPlatforms: PluginPlatform[];
  files: PluginFileDraft[];
  scope: ResourceVisibilityScope;
  teamIds: string[];
  userIds: string[];
}

/**
 * `/plugins/[id]/edit` — the create wizard's Content and Access steps on an
 * existing plugin, URL-driven by `?step=`. One draft spans both steps; Save
 * on either step writes it and returns to the plugin's page, Save & Continue
 * writes it and moves on.
 */
export function PluginEditPage({ id }: { id: string }) {
  const enabled = useFeature("plugins");
  const {
    data: plugin,
    isPending,
    isLoadingError,
    refetch,
  } = usePlugin(enabled === true ? id : null);

  if (enabled === undefined || (enabled && isPending)) {
    return <PluginPageLoading />;
  }
  if (!enabled) {
    return (
      <PageLayout
        title="Plugins"
        description="Plugins are disabled for this deployment."
      >
        <div />
      </PageLayout>
    );
  }
  if (isLoadingError) {
    return (
      <PageLayout title="Edit plugin" description="Edit plugin configuration.">
        <QueryLoadError
          title="Couldn't load this plugin"
          onRetry={() => refetch()}
        />
      </PageLayout>
    );
  }
  if (!plugin) return <PluginNotFound />;
  return <PluginEditWizard plugin={plugin} />;
}

function PluginEditWizard({ plugin }: { plugin: PluginDetail }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { data: canUpdate } = useHasPermissions({
    plugin: ["update", "admin"],
  });
  const updatePlugin = useUpdatePlugin(plugin.id);

  const isGithubPlugin = plugin.sourceKind === "github";
  const editSteps = isGithubPlugin
    ? PLUGIN_EDIT_STEPS.filter(({ id }) => id === "access")
    : PLUGIN_EDIT_STEPS;
  const requestedStep = resolvePluginEditStep(searchParams.get("step"));
  const step = isGithubPlugin ? "access" : requestedStep;
  const stepIndex = editSteps.findIndex((item) => item.id === step);
  const prevStep = editSteps[stepIndex - 1];
  const nextStep = editSteps[stepIndex + 1];
  const detailHref = pluginDetailHref(plugin.id);
  const goToStep = (target: PluginEditStepId) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("step", target);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  // The draft is seeded from the loaded plugin; a content-hash-keyed remount
  // on the page above would discard unsaved work on every background refetch,
  // so the seed is taken once and refreshed only while the draft is clean.
  const seed = useMemo<PluginDraft>(
    () => ({
      displayName: plugin.displayName,
      description: plugin.description,
      enabled: plugin.enabled,
      supportedPlatforms: plugin.supportedPlatforms,
      files: plugin.files.map(({ path, content, encoding, mode }) => ({
        path,
        content,
        encoding,
        mode,
      })),
      scope: plugin.scope,
      teamIds: plugin.teams.map((team) => team.id),
      userIds: plugin.users.map((member) => member.id),
    }),
    [plugin],
  );
  const [draft, setDraft] = useState<PluginDraft>(seed);
  const [base, setBase] = useState<PluginDraft>(seed);
  const isDirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(base),
    [draft, base],
  );

  useEffect(() => {
    if (isDirty) return;
    setDraft(seed);
    setBase(seed);
  }, [isDirty, seed]);

  const patchDraft = (patch: Partial<PluginDraft>) =>
    setDraft((prev) => ({ ...prev, ...patch }));

  const discardChanges = () => {
    setDraft(base);
  };

  const contentComplete =
    draft.displayName.trim().length > 0 && draft.files.length > 0;
  // Which save is in flight: Save finishes on the plugin's page, Save &
  // Continue moves to the next step.
  const [savingWith, setSavingWith] = useState<"finish" | "continue" | null>(
    null,
  );
  const isSaving = savingWith !== null;

  const handleSave = async (intent: "finish" | "continue") => {
    const submitted = draft;
    setSavingWith(intent);
    const saved = await updatePlugin
      .mutateAsync({
        ...(isGithubPlugin
          ? {}
          : {
              displayName: submitted.displayName.trim(),
              description: submitted.description,
              enabled: submitted.enabled,
              supportedPlatforms: submitted.supportedPlatforms,
              files: submitted.files,
            }),
        scope: submitted.scope,
        teamIds: submitted.scope === "team" ? submitted.teamIds : [],
        userIds: submitted.scope === "personal" ? submitted.userIds : [],
      })
      .catch(() => null);
    setSavingWith(null);
    if (!saved) return;
    setBase(submitted);
    if (intent === "continue" && nextStep) goToStep(nextStep.id);
    else router.push(detailHref);
  };

  // Unsaved edits guard every way out of the wizard that is not a save: the
  // back link and Cancel. Steps share the draft, so moving between them
  // loses nothing and asks nothing.
  useBeforeUnloadWhileDirty(isDirty);
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

  return (
    <PageLayout
      title={`Edit ${plugin.displayName}`}
      documentTitle={`Edit ${plugin.displayName}`}
      description={STEP_DESCRIPTIONS[step]}
      backLink={
        <PluginBackLink
          href={detailHref}
          label="Back to plugin"
          onClick={(event) => {
            if (!isDirty) return;
            event.preventDefault();
            requestNavigate(detailHref);
          }}
        />
      }
      maxWidth="wizard"
    >
      <div className="space-y-6">
        {!isGithubPlugin && (
          <WizardStepper
            steps={[...editSteps]}
            activeStep={step}
            onStepClick={(target) => {
              if (target !== step) goToStep(target);
            }}
          />
        )}

        {canUpdate === false && (
          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription>
              You can view this plugin&apos;s configuration but not change it.
            </AlertDescription>
          </Alert>
        )}

        <div className="flex flex-col gap-4">
          <div className="flex min-h-0 flex-col gap-4 rounded-lg border p-6">
            {/* Kept mounted across steps: the open file and editor scroll
                position are the editor's own state, and a trip to Access is
                not a decision to drop them. */}
            {!isGithubPlugin && (
              <div
                className={cn(
                  "flex min-h-0 flex-col",
                  step !== "content" && "hidden",
                )}
              >
                <PluginContentFields
                  displayName={draft.displayName}
                  onDisplayNameChange={(displayName) =>
                    patchDraft({ displayName })
                  }
                  description={draft.description}
                  onDescriptionChange={(description) =>
                    patchDraft({ description })
                  }
                  pluginSlug={plugin.pluginSlug}
                  platforms={draft.supportedPlatforms}
                  onPlatformsChange={(supportedPlatforms) =>
                    patchDraft({ supportedPlatforms })
                  }
                  files={draft.files}
                  onFilesChange={(files) => patchDraft({ files })}
                  readOnly={canUpdate === false}
                />
              </div>
            )}
            {step === "access" && (
              <fieldset disabled={canUpdate === false} className="contents">
                <PluginScopeSelector
                  scope={draft.scope}
                  onScopeChange={(scope) => patchDraft({ scope })}
                  teamIds={draft.teamIds}
                  onTeamIdsChange={(teamIds) => patchDraft({ teamIds })}
                  userIds={draft.userIds}
                  onUserIdsChange={(userIds) => patchDraft({ userIds })}
                />
              </fieldset>
            )}
          </div>
          <WizardFooter>
            <div className="flex items-center gap-2">
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
              {isDirty && !isSaving && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={discardChanges}
                >
                  Discard changes
                </Button>
              )}
            </div>
            <div className="flex items-center gap-2">
              {isDirty || isSaving ? (
                <PermissionButton
                  permissions={{ plugin: ["update", "admin"] }}
                  variant={nextStep ? "outline" : "default"}
                  disabled={!contentComplete || isSaving}
                  onClick={() => handleSave("finish")}
                >
                  {savingWith === "finish" ? "Saving..." : "Save"}
                </PermissionButton>
              ) : (
                <Button
                  type="button"
                  variant={nextStep ? "outline" : "default"}
                  onClick={() => router.push(detailHref)}
                >
                  Save
                </Button>
              )}
              {nextStep &&
                (isDirty || isSaving ? (
                  <PermissionButton
                    permissions={{ plugin: ["update", "admin"] }}
                    disabled={!contentComplete || isSaving}
                    onClick={() => handleSave("continue")}
                  >
                    <span>
                      {savingWith === "continue"
                        ? "Saving..."
                        : "Save & Continue"}
                    </span>
                    <ArrowRight className="h-4 w-4" />
                  </PermissionButton>
                ) : (
                  <Button
                    type="button"
                    disabled={!contentComplete}
                    onClick={() => goToStep(nextStep.id)}
                  >
                    <span>{nextStep.title}</span>
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                ))}
            </div>
          </WizardFooter>
        </div>

        <UnsavedChangesDialog
          open={guard.confirmOpen}
          onKeepEditing={guard.keepEditing}
          onDiscard={guard.discardChanges}
        />
      </div>
    </PageLayout>
  );
}

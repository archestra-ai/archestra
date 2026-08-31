"use client";

import type { ResourceVisibilityScope } from "@archestra/shared";
import { ArrowLeft, ArrowRight, Info } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  GithubAuthConfigFields,
  type GithubAuthMethod,
} from "@/components/github-auth-config-fields";
import { PageLayout } from "@/components/page-layout";
import { QueryLoadError } from "@/components/query-load-error";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PermissionButton } from "@/components/ui/permission-button";
import { SecretInput } from "@/components/ui/secret-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  UnsavedChangesDialog,
  useBeforeUnloadWhileDirty,
  useUnsavedChangesGuard,
} from "@/components/unsaved-changes-guard";
import { WizardFooter } from "@/components/wizard-footer";
import { WizardStepper } from "@/components/wizard-stepper";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useGithubAppConfigs } from "@/lib/github-app-config.query";
import { useCreateGithubPat } from "@/lib/github-pat.query";
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

const GITHUB_SYNC_OPTIONS = [
  { value: "off", label: "Manual checks" },
  { value: "15m", label: "Every 15 minutes" },
  { value: "1h", label: "Every hour" },
  { value: "1d", label: "Once a day" },
] as const;

interface PluginDraft {
  displayName: string;
  description: string;
  enabled: boolean;
  supportedPlatforms: PluginPlatform[];
  files: PluginFileDraft[];
  scope: ResourceVisibilityScope;
  teamIds: string[];
  userIds: string[];
  githubRepoUrl: string;
  githubSyncRef: string;
  githubSyncInterval: "15m" | "1h" | "1d" | null;
  githubAuthMethod: GithubAuthMethod;
  githubAppConfigId: string;
  githubToken: string;
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
        maxWidth="wizard"
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
  const { data: githubAppConfigs = [] } = useGithubAppConfigs();
  const createGithubPat = useCreateGithubPat();

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
      githubRepoUrl: plugin.sourceRepo ?? "",
      githubSyncRef: plugin.githubSyncRef ?? plugin.sourceRef ?? "",
      githubSyncInterval: plugin.githubSyncInterval,
      githubAuthMethod: plugin.githubAppConfigId ? "github_app" : "pat",
      githubAppConfigId: plugin.githubAppConfigId ?? "",
      githubToken: "",
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
  const githubAuthenticationComplete =
    draft.githubAuthMethod === "github_app"
      ? draft.githubAppConfigId.length > 0
      : base.githubAuthMethod !== "github_app" ||
        draft.githubToken.trim().length > 0;
  const sourceComplete =
    !isGithubPlugin ||
    (draft.githubRepoUrl.trim().length > 0 && githubAuthenticationComplete);
  // Which save is in flight: Save finishes on the plugin's page, Save &
  // Continue moves to the next step.
  const [savingWith, setSavingWith] = useState<"finish" | "continue" | null>(
    null,
  );
  const isSaving = savingWith !== null;

  const handleSave = async (intent: "finish" | "continue") => {
    let submitted = draft;
    setSavingWith(intent);
    let githubPatId =
      submitted.githubAuthMethod === "pat" ? plugin.githubPatId : null;
    if (
      isGithubPlugin &&
      submitted.githubAuthMethod === "pat" &&
      submitted.githubToken.trim()
    ) {
      const created = await createGithubPat
        .mutateAsync({
          name: `${plugin.displayName} token`,
          token: submitted.githubToken.trim(),
        })
        .catch(() => null);
      if (!created) {
        setSavingWith(null);
        return;
      }
      githubPatId = created.id;
      submitted = {
        ...submitted,
        githubToken: "",
      };
      setDraft(submitted);
    }
    const githubAppConfigId =
      submitted.githubAuthMethod === "github_app"
        ? submitted.githubAppConfigId || null
        : null;
    const baseGithubPatId =
      base.githubAuthMethod === "pat" ? plugin.githubPatId : null;
    const baseGithubAppConfigId =
      base.githubAuthMethod === "github_app"
        ? base.githubAppConfigId || null
        : null;
    const githubAuthenticationChanged =
      githubPatId !== baseGithubPatId ||
      githubAppConfigId !== baseGithubAppConfigId;
    const saved = await updatePlugin
      .mutateAsync({
        ...(isGithubPlugin
          ? {
              githubSource: {
                repoUrl: submitted.githubRepoUrl.trim(),
                ref: submitted.githubSyncRef.trim() || null,
                syncInterval: submitted.githubSyncInterval,
                ...(githubAuthenticationChanged
                  ? {
                      authentication: {
                        githubAppConfigId,
                        githubPatId,
                      },
                    }
                  : {}),
              },
            }
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
  const githubAppConfigOptions =
    plugin.githubAppConfigId &&
    !githubAppConfigs.some((config) => config.id === plugin.githubAppConfigId)
      ? [
          {
            id: plugin.githubAppConfigId,
            name: "Current GitHub App configuration",
          },
          ...githubAppConfigs,
        ]
      : githubAppConfigs;

  return (
    <PageLayout
      title={`Edit ${plugin.displayName}`}
      documentTitle={`Edit ${plugin.displayName}`}
      description={
        isGithubPlugin
          ? "Edit the tracked GitHub source, authentication, update schedule, and discoverability."
          : STEP_DESCRIPTIONS[step]
      }
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
      actionButton={
        !isGithubPlugin ? (
          <WizardStepper
            compact
            steps={[...editSteps]}
            activeStep={step}
            onStepClick={(target) => {
              if (target !== step) goToStep(target);
            }}
          />
        ) : undefined
      }
      maxWidth="wizard"
    >
      <div className="space-y-6">
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
                {isGithubPlugin && (
                  <div className="space-y-5 border-b pb-6">
                    <div className="space-y-2">
                      <Label htmlFor="plugin-github-repo-url">
                        Repository URL
                      </Label>
                      <Input
                        id="plugin-github-repo-url"
                        value={draft.githubRepoUrl}
                        onChange={(event) =>
                          patchDraft({ githubRepoUrl: event.target.value })
                        }
                        placeholder="github.com/owner/repo"
                        autoComplete="off"
                        data-1p-ignore
                        data-lpignore="true"
                      />
                      <p className="text-sm text-muted-foreground">
                        The GitHub repository checked for plugin updates.
                      </p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="plugin-github-sync-interval">
                        Keep in sync
                      </Label>
                      <Select
                        value={draft.githubSyncInterval ?? "off"}
                        onValueChange={(value) =>
                          patchDraft({
                            githubSyncInterval:
                              value === "off"
                                ? null
                                : (value as "15m" | "1h" | "1d"),
                          })
                        }
                      >
                        <SelectTrigger
                          id="plugin-github-sync-interval"
                          className="w-full"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {GITHUB_SYNC_OPTIONS.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-sm text-muted-foreground">
                        New commits become review candidates and never replace
                        approved plugin bytes automatically.
                      </p>
                    </div>
                    <GithubAuthConfigFields
                      authMethod={draft.githubAuthMethod}
                      onAuthMethodChange={(githubAuthMethod) =>
                        patchDraft({
                          githubAuthMethod,
                          ...(githubAuthMethod === "pat"
                            ? { githubAppConfigId: "" }
                            : {}),
                        })
                      }
                      githubAppConfigId={draft.githubAppConfigId}
                      onGithubAppConfigIdChange={(githubAppConfigId) =>
                        patchDraft({ githubAppConfigId })
                      }
                      githubAppConfigs={githubAppConfigOptions}
                      patFields={
                        <div className="space-y-2">
                          <Label htmlFor="plugin-github-token">
                            Personal Access Token
                          </Label>
                          <SecretInput
                            id="plugin-github-token"
                            value={draft.githubToken}
                            onChange={(event) =>
                              patchDraft({ githubToken: event.target.value })
                            }
                            placeholder="Leave empty to keep existing token"
                          />
                          <p className="text-sm text-muted-foreground">
                            <span>
                              Leave empty to keep existing credentials
                              unchanged.
                            </span>{" "}
                            <span>
                              Fine-grained or classic — see{" "}
                              <a
                                href="https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens"
                                target="_blank"
                                rel="noreferrer"
                                className="font-medium text-primary underline-offset-4 hover:underline"
                              >
                                managing your personal access tokens
                              </a>
                              .
                            </span>
                          </p>
                        </div>
                      }
                    />
                    <div className="space-y-2">
                      <Label htmlFor="plugin-github-sync-ref">Ref</Label>
                      <Input
                        id="plugin-github-sync-ref"
                        value={draft.githubSyncRef}
                        onChange={(event) =>
                          patchDraft({ githubSyncRef: event.target.value })
                        }
                        placeholder="Default branch"
                        autoComplete="off"
                      />
                      <p className="text-sm text-muted-foreground">
                        Leave empty to track the repository&apos;s default
                        branch.
                      </p>
                    </div>
                  </div>
                )}
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
                  disabled={!contentComplete || !sourceComplete || isSaving}
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
                    disabled={!contentComplete || !sourceComplete || isSaving}
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
                    disabled={!contentComplete || !sourceComplete}
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

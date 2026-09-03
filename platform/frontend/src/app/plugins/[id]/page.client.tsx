"use client";

import {
  Github,
  Info,
  Loader2,
  MoreHorizontal,
  PackagePlus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { AgentBadge } from "@/components/agent-badge";
import type { ProfileLabelsRef } from "@/components/agent-labels";
import { CreatedByCell } from "@/components/created-by-cell";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { PageLayout } from "@/components/page-layout";
import { QueryLoadError } from "@/components/query-load-error";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  UnsavedChangesDialog,
  useBeforeUnloadWhileDirty,
  useGuardedInAppNavigation,
  useUnsavedChangesGuard,
} from "@/components/unsaved-changes-guard";
import { WizardFooter } from "@/components/wizard-footer";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { formatPermissionConstraint } from "@/lib/auth/auth.utils";
import { useFeature } from "@/lib/config/config.query";
import { useGithubAppConfigs } from "@/lib/github-app-config.query";
import { useCreateGithubPat } from "@/lib/github-pat.query";
import {
  type PluginDetail,
  useDeletePlugin,
  usePlugin,
  useUpdatePlugin,
} from "@/lib/plugins/plugin.query";
import {
  getPluginActionModel,
  pluginAction,
} from "../_parts/plugin-actions-model";
import {
  isPluginDraftComplete,
  isPluginDraftDirty,
  type PluginDraft,
  pluginDraftFromPlugin,
} from "../_parts/plugin-draft";
import { PluginForm } from "../_parts/plugin-form";
import { PluginGithubUpdatesDialog } from "../_parts/plugin-github-updates-dialog";
import { PluginInstallDialog } from "../_parts/plugin-install-dialog";
import {
  ARCHESTRA_PLUGIN_AUTHOR_LABEL,
  CLIENT_LABELS,
  isArchestraPlugin,
  PLUGIN_DESCRIPTION_FALLBACK,
} from "../_parts/plugin-page-config";
import {
  PluginBackLink,
  PluginNotFound,
  PluginPageLoading,
} from "../_parts/plugin-page-shell";

/**
 * `/plugins/[id]` — one plugin's page. Its metadata, payload and access are
 * edited here rather than behind an Edit button that opened a wizard on a
 * second route: the plugin's settings are the page. The layout intentionally
 * mirrors the skill page.
 */
export default function PluginDetailPage({ id }: { id: string }) {
  const enabled = useFeature("plugins");
  const {
    data: plugin,
    isPending,
    isLoadingError,
    refetch,
  } = usePlugin(enabled === true ? id : null);

  // Hold the last plugin this mount saw. Deleting it in another tab (or any
  // background refetch that answers 404) turns `data` into null, and dropping
  // the page on that would throw away whatever has been typed into the form
  // since. The page stays up on the held copy and says it is gone.
  const heldPluginRef = useRef<PluginDetail | null>(null);
  if (plugin) heldPluginRef.current = plugin;
  const heldPlugin = plugin ?? heldPluginRef.current;
  const isGone = !plugin && !!heldPluginRef.current;

  // Deleting invalidates the plugins queries, and the refetch resolves to null
  // before the navigation back to the list has finished — without the flag the
  // page would flash "Plugin not found" for a delete that just succeeded.
  const [isLeavingAfterDelete, setIsLeavingAfterDelete] = useState(false);
  const router = useRouter();

  if (enabled === undefined || (enabled && isPending && !heldPlugin)) {
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
      <PageLayout title="Plugin" description="View plugin configuration.">
        <QueryLoadError
          title="Couldn't load this plugin"
          onRetry={() => refetch()}
        />
      </PageLayout>
    );
  }

  if (!heldPlugin || isLeavingAfterDelete) {
    if (isLeavingAfterDelete) return <PluginPageLoading />;
    return <PluginNotFound />;
  }

  return (
    <PluginDetailView
      plugin={heldPlugin}
      isGone={isGone}
      onDeleted={() => {
        setIsLeavingAfterDelete(true);
        router.push("/plugins");
      }}
    />
  );
}

function PluginDetailView({
  plugin,
  isGone,
  onDeleted,
}: {
  plugin: PluginDetail;
  /** The plugin has since been deleted; this is the last copy we hold. */
  isGone: boolean;
  onDeleted: () => void;
}) {
  const router = useRouter();
  const { data: canDelete } = useHasPermissions({
    plugin: ["delete", "admin"],
  });
  const { data: canUpdate } = useHasPermissions({
    plugin: ["update", "admin"],
  });
  const isReadOnly = canUpdate === false;
  const updatePlugin = useUpdatePlugin(plugin.id);
  const { data: githubAppConfigs = [] } = useGithubAppConfigs();
  const createGithubPat = useCreateGithubPat();

  const isGithubPlugin = plugin.sourceKind === "github";
  const isArchestra = isArchestraPlugin(plugin);
  const actionModel = getPluginActionModel({
    pluginId: plugin.id,
    hasPendingUpdate: !!plugin.pendingSourceSha,
  });
  const installAction = pluginAction(actionModel, "install");
  const updatesAction = pluginAction(actionModel, "updates");
  const deleteAction = pluginAction(actionModel, "delete");
  const updateReason = isReadOnly
    ? formatPermissionConstraint(updatesAction.permissions)
    : undefined;
  const deleteReason =
    canDelete === false
      ? formatPermissionConstraint(deleteAction.permissions)
      : undefined;
  const updateReasonId = useId();
  const deleteReasonId = useId();

  // The draft is seeded from the loaded plugin and refreshed only while it is
  // clean: this page is open for as long as someone is editing, and reads land
  // under it unbidden (a window-focus refetch, a sync check, another tab's
  // save), so adopting every read would discard unsaved work.
  const seed = useMemo<PluginDraft>(
    () => pluginDraftFromPlugin(plugin),
    [plugin],
  );
  const [draft, setDraft] = useState<PluginDraft>(seed);
  const [base, setBase] = useState<PluginDraft>(seed);
  const labelsRef = useRef<ProfileLabelsRef>(null);
  const isDirty = isPluginDraftDirty(draft, base);

  useEffect(() => {
    if (isDirty) return;
    setDraft(seed);
    setBase(seed);
  }, [isDirty, seed]);

  const patchDraft = (patch: Partial<PluginDraft>) =>
    setDraft((prev) => ({ ...prev, ...patch }));
  const discardChanges = () => setDraft(base);

  const isComplete = isPluginDraftComplete({
    draft,
    isGithubPlugin,
    seedAuthMethod: base.githubAuthMethod,
  });
  const [isSaving, setIsSaving] = useState(false);

  const handleSave = async () => {
    const finalLabels = labelsRef.current?.saveUnsavedLabel() ?? draft.labels;
    let submitted = { ...draft, labels: finalLabels };
    setIsSaving(true);
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
        setIsSaving(false);
        return;
      }
      githubPatId = created.id;
      // The typed token is exchanged for a saved credential, so it is dropped
      // from the draft rather than kept around in component state.
      submitted = { ...submitted, githubToken: "" };
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
                      authentication: { githubAppConfigId, githubPatId },
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
        labels: submitted.labels,
      })
      .catch(() => null);
    setIsSaving(false);
    if (!saved) return;
    setBase(submitted);
  };

  // Unsaved edits guard every way off the page that is not a save: the back
  // link, the sidebar, anything else on screen. The pending destination is
  // parked here and taken once the guard lets go.
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
  useGuardedInAppNavigation({ isDirty, onRequestNavigate: requestNavigate });

  // A GitHub App configuration the reader cannot list still has to show as the
  // plugin's current one rather than as an empty select.
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

  const [deleteRequested, setDeleteRequested] = useState(false);
  const [updatesOpen, setUpdatesOpen] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const deletePlugin = useDeletePlugin(plugin.id);

  const handleDelete = async () => {
    const deleted = await deletePlugin.mutateAsync();
    if (deleted) onDeleted();
  };

  return (
    <PageLayout
      title={
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="min-w-0 truncate">{plugin.displayName}</span>
          <AgentBadge type={plugin.scope} className="font-normal" />
          <Badge variant="secondary" className="font-normal">
            {CLIENT_LABELS[plugin.clientType] ?? plugin.clientType}
          </Badge>
          {isGithubPlugin && !isArchestra && (
            <Badge variant="secondary" className="gap-1 font-normal">
              <Github className="h-3 w-3" />
              {plugin.githubSyncInterval
                ? "Checked against GitHub"
                : "Imported from GitHub"}
            </Badge>
          )}
          {isArchestra && (
            <Badge variant="secondary" className="font-normal">
              {ARCHESTRA_PLUGIN_AUTHOR_LABEL}
            </Badge>
          )}
          {!plugin.enabled && (
            <Badge variant="outline" className="font-normal">
              Disabled
            </Badge>
          )}
        </div>
      }
      documentTitle={plugin.displayName}
      description={plugin.description || PLUGIN_DESCRIPTION_FALLBACK}
      backLink={<PluginBackLink href="/plugins" label="Plugins" />}
      maxWidth="wizard"
      minWidth="phone"
      actionButton={
        // Editing is the page itself now, so the header carries only what the
        // page cannot: installing the plugin, and the actions that act on it
        // as a whole.
        <div className="flex shrink-0 items-center gap-2">
          {/* Who to ask about this plugin. The facts row this used to sit in
              is gone — the page is the plugin's own settings, top to bottom.
              Dropped on phones, where the header has no room to spare. */}
          {plugin.createdBy && (
            <p className="mr-1 hidden items-center gap-1.5 text-xs text-muted-foreground md:flex">
              <span className="shrink-0">Created by</span>
              <CreatedByCell createdBy={plugin.createdBy} />
            </p>
          )}
          {plugin.enabled && (
            <PermissionButton
              permissions={installAction.permissions}
              variant="outline"
              onClick={() => setInstallOpen(true)}
            >
              <PackagePlus className="h-4 w-4" />
              {installAction.label}
            </PermissionButton>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon">
                <MoreHorizontal className="h-4 w-4" />
                <span className="sr-only">More actions</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {isGithubPlugin && (
                <DropdownMenuItem
                  aria-disabled={isReadOnly || undefined}
                  aria-describedby={updateReason ? updateReasonId : undefined}
                  className={
                    isReadOnly ? "cursor-not-allowed opacity-50" : undefined
                  }
                  onSelect={(event) => {
                    if (isReadOnly) event.preventDefault();
                  }}
                  onClick={(event) => {
                    if (isReadOnly) {
                      event.preventDefault();
                      return;
                    }
                    setUpdatesOpen(true);
                  }}
                >
                  <RefreshCw className="h-4 w-4" />
                  {updatesAction.label}
                  {updateReason && (
                    <span
                      id={updateReasonId}
                      aria-hidden="true"
                      className="sr-only"
                    >
                      {updateReason}
                    </span>
                  )}
                </DropdownMenuItem>
              )}
              {isGithubPlugin && <DropdownMenuSeparator />}
              <DropdownMenuItem
                variant="destructive"
                aria-disabled={canDelete !== true || undefined}
                aria-describedby={deleteReason ? deleteReasonId : undefined}
                className={
                  canDelete === true
                    ? undefined
                    : "cursor-not-allowed opacity-50"
                }
                onSelect={(event) => {
                  if (canDelete !== true) event.preventDefault();
                }}
                onClick={(event) => {
                  if (canDelete !== true) {
                    event.preventDefault();
                    return;
                  }
                  setDeleteRequested(true);
                }}
              >
                <Trash2 className="h-4 w-4" />
                {deleteAction.label}
                {deleteReason && (
                  <span
                    id={deleteReasonId}
                    aria-hidden="true"
                    className="sr-only"
                  >
                    {deleteReason}
                  </span>
                )}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {isGone ? (
          <Alert variant="destructive">
            <AlertDescription>
              This plugin is no longer available — it was deleted while you were
              editing it. Your unsaved changes cannot be saved; copy anything
              you need before leaving.
            </AlertDescription>
          </Alert>
        ) : (
          isReadOnly && (
            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription>
                You can view this plugin&apos;s configuration but not change it.
              </AlertDescription>
            </Alert>
          )
        )}

        <PluginForm
          draft={draft}
          onChange={patchDraft}
          labelsRef={labelsRef}
          readOnly={isReadOnly}
          pluginSlug={plugin.pluginSlug}
          isGithubPlugin={isGithubPlugin}
          githubAppConfigs={githubAppConfigOptions}
        />

        {/* A reader who cannot change the plugin has no save row at all — the
            alert above already says why. */}
        {!isReadOnly && (
          <WizardFooter className="border-t-0 sm:justify-end">
            <div className="flex items-center gap-2">
              {isDirty && !isSaving && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={discardChanges}
                >
                  Discard changes
                </Button>
              )}
              <PermissionButton
                permissions={{ plugin: ["update", "admin"] }}
                disabled={!isDirty || !isComplete || isGone || isSaving}
                onClick={handleSave}
              >
                {isSaving ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>Saving...</span>
                  </>
                ) : (
                  <span>Save changes</span>
                )}
              </PermissionButton>
            </div>
          </WizardFooter>
        )}
      </div>

      <UnsavedChangesDialog
        open={guard.confirmOpen}
        onKeepEditing={() => {
          pendingHrefRef.current = null;
          guard.keepEditing();
        }}
        onDiscard={guard.discardChanges}
      />
      <DeleteConfirmDialog
        open={deleteRequested}
        onOpenChange={setDeleteRequested}
        title="Delete plugin?"
        description="Installed copies stay on developer machines until you uninstall them."
        isPending={deletePlugin.isPending}
        onConfirm={handleDelete}
      />
      {updatesOpen && (
        <PluginGithubUpdatesDialog
          plugin={plugin}
          open={updatesOpen}
          onOpenChange={setUpdatesOpen}
        />
      )}
      {installOpen && (
        <PluginInstallDialog
          plugins={[plugin]}
          open={installOpen}
          onOpenChange={setInstallOpen}
        />
      )}
    </PageLayout>
  );
}

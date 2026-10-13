"use client";

import { GIT_PROVIDER_LABELS } from "@archestra/shared";
import {
  Info,
  Loader2,
  MoreHorizontal,
  PackagePlus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ProfileLabelsRef } from "@/components/agent-labels";
import { CreatedByCell } from "@/components/created-by-cell";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { GitSourceTooltip } from "@/components/git/git-source-card";
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
import { useGitCredentials } from "@/lib/git-credentials.query";
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
import { PluginGitSourceCard } from "../_parts/plugin-git-source";
import { PluginGithubUpdatesDialog } from "../_parts/plugin-github-updates-dialog";
import { PluginInstallDialog } from "../_parts/plugin-install-dialog";
import {
  CLIENT_LABELS,
  PLUGIN_DESCRIPTION_FALLBACK,
} from "../_parts/plugin-page-config";
import {
  PluginBackLink,
  PluginNotFound,
  PluginPageLoading,
} from "../_parts/plugin-page-shell";
import { PluginSourceGlyph } from "../_parts/plugin-source-icon";

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
  const searchParams = useSearchParams();
  const activeSection =
    searchParams.get("tab") === "permissions" ? "permissions" : "general";
  const pluginHref = `/plugins/${plugin.id}`;
  const { data: canDelete } = useHasPermissions(
    { plugin: ["delete", "update"] },
    "*",
  );
  const { data: canUpdate } = useHasPermissions({ plugin: ["update"] }, "*");
  const isReadOnly = canUpdate === false;
  const updatePlugin = useUpdatePlugin(plugin.id);
  const { data: canReadCredentials } = useHasPermissions({
    credential: ["read"],
  });
  const { data: gitCredentials = [] } = useGitCredentials(
    canReadCredentials === true,
  );

  const isGithubPlugin = plugin.sourceKind === "github";
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

  const isComplete = isPluginDraftComplete({ draft, isGithubPlugin });
  const [isSaving, setIsSaving] = useState(false);

  const handleSave = async () => {
    const finalLabels = labelsRef.current?.saveUnsavedLabel() ?? draft.labels;
    const submitted = { ...draft, labels: finalLabels };
    setIsSaving(true);
    // A Git plugin's source saves from its own dialog; the page only owns
    // what the repository does not.
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
      if (href === pluginHref || href === `${pluginHref}?tab=permissions`) {
        router.replace(href, { scroll: false });
        return;
      }
      pendingHrefRef.current = href;
      guard.requestClose();
    },
    [guard, pluginHref, router],
  );
  useGuardedInAppNavigation({ isDirty, onRequestNavigate: requestNavigate });

  // The credentials the source can be read with: those on its host's
  // provider, plus the one it uses now even when this reader can't list it
  // (a legacy saved GitHub token stays selectable, but is no longer offered).
  const gitProvider = plugin.sourceProvider ?? "github";
  const gitCredentialOptions = gitCredentials
    .filter((credential) => credential.provider === gitProvider)
    .map((credential) => ({
      value: `${credential.kind}:${credential.id}`,
      label: credential.name,
    }));
  if (
    seed.gitCredential &&
    !gitCredentialOptions.some((option) => option.value === seed.gitCredential)
  )
    gitCredentialOptions.unshift({
      value: seed.gitCredential,
      label: seed.gitCredential.startsWith("pat:")
        ? "Saved GitHub token"
        : "Current credential",
    });

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
      icon={
        isGithubPlugin ? (
          <GitSourceTooltip
            label={`${plugin.githubSyncInterval ? "Checked against" : "Imported from"} ${GIT_PROVIDER_LABELS[gitProvider]}`}
            detail={plugin.sourceRepo}
          >
            <PluginSourceGlyph plugin={plugin} />
          </GitSourceTooltip>
        ) : (
          <PluginSourceGlyph plugin={plugin} />
        )
      }
      title={
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="min-w-0 truncate">{plugin.displayName}</span>
          <Badge variant="secondary" className="font-normal">
            {CLIENT_LABELS[plugin.clientType] ?? plugin.clientType}
          </Badge>
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
      contentOverflowX="clip"
      tabs={[
        {
          label: "General",
          href: pluginHref,
          selected: activeSection === "general",
        },
        {
          label: "Permissions",
          href: `${pluginHref}?tab=permissions`,
          selected: activeSection === "permissions",
        },
      ]}
      mobileVisibleCount={2}
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
              permissionScope={installAction.permissionScope}
              variant="outline"
              size="sm"
              onClick={() => setInstallOpen(true)}
            >
              <PackagePlus className="h-4 w-4" />
              {installAction.label}
            </PermissionButton>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon-sm">
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

        {/* Where the files come from comes first: it is why they are locked. */}
        {isGithubPlugin && activeSection === "general" && (
          <PluginGitSourceCard
            plugin={plugin}
            source={{
              provider: gitProvider,
              credentials: gitCredentialOptions,
            }}
            canEdit={!isReadOnly}
            onReview={() => setUpdatesOpen(true)}
          />
        )}

        <PluginForm
          draft={draft}
          onChange={patchDraft}
          labelsRef={labelsRef}
          readOnly={isReadOnly}
          pluginSlug={plugin.pluginSlug}
          pluginId={plugin.id}
          isGithubPlugin={isGithubPlugin}
          activeSection={activeSection}
        />

        {activeSection === "general" && !isReadOnly && (
          <WizardFooter>
            <div>
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
              <PermissionButton
                permissions={{ plugin: ["update"] }}
                permissionScope="*"
                disabled={!isDirty || !isComplete || isGone || isSaving}
                onClick={handleSave}
              >
                {isSaving ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>Saving...</span>
                  </>
                ) : (
                  <span>Save</span>
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

"use client";

import {
  Github,
  MoreHorizontal,
  PackagePlus,
  Pencil,
  RefreshCw,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useId, useState } from "react";
import { AgentBadge } from "@/components/agent-badge";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import {
  type OverviewFact,
  OverviewSummary,
} from "@/components/overview-summary";
import { PageLayout } from "@/components/page-layout";
import { QueryLoadError } from "@/components/query-load-error";
import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
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
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { formatPermissionConstraint } from "@/lib/auth/auth.utils";
import { useFeature } from "@/lib/config/config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import {
  type PluginDetail,
  useDeletePlugin,
  usePlugin,
} from "@/lib/plugins/plugin.query";
import {
  SKILL_DETAIL_EDITOR_CLASS,
  SkillContentEditor,
} from "../../skills/_parts/skill-content-editor";
import {
  getPluginActionModel,
  pluginAction,
  pluginActionHref,
} from "../_parts/plugin-actions-model";
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
 * `/plugins/[id]` — the plugin as it is: its facts, then its payload,
 * read-only. Changing anything goes through the page header's Edit, which
 * opens the wizard (the create wizard's Content and Access steps on the
 * existing plugin). The layout intentionally mirrors the Skill details page.
 */
export default function PluginDetailPage({ id }: { id: string }) {
  const enabled = useFeature("plugins");
  const {
    data: plugin,
    isPending,
    isLoadingError,
    refetch,
  } = usePlugin(enabled === true ? id : null);

  // Deleting invalidates the plugins queries, and the refetch resolves to null
  // before the navigation back to the list has finished — without the flag the
  // page would flash "Plugin not found" for a delete that just succeeded.
  const [isLeavingAfterDelete, setIsLeavingAfterDelete] = useState(false);
  const router = useRouter();

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
      <PageLayout title="Plugin" description="View plugin configuration.">
        <QueryLoadError
          title="Couldn't load this plugin"
          onRetry={() => refetch()}
        />
      </PageLayout>
    );
  }

  if (!plugin) {
    if (isLeavingAfterDelete) return <PluginPageLoading />;
    return <PluginNotFound />;
  }

  return (
    <PluginDetailView
      plugin={plugin}
      onDeleted={() => {
        setIsLeavingAfterDelete(true);
        router.push("/plugins");
      }}
    />
  );
}

function PluginDetailView({
  plugin,
  onDeleted,
}: {
  plugin: PluginDetail;
  onDeleted: () => void;
}) {
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;
  const { data: canDelete } = useHasPermissions({
    plugin: ["delete", "admin"],
  });
  const { data: canUpdate } = useHasPermissions({
    plugin: ["update", "admin"],
  });

  const isGithubPlugin = plugin.sourceKind === "github";
  const isArchestra = isArchestraPlugin(plugin);
  const actionModel = getPluginActionModel({
    pluginId: plugin.id,
    hasPendingUpdate: !!plugin.pendingSourceSha,
  });
  const installAction = pluginAction(actionModel, "install");
  const editAction = pluginAction(actionModel, "edit");
  const updatesAction = pluginAction(actionModel, "updates");
  const deleteAction = pluginAction(actionModel, "delete");
  const updateReason =
    canUpdate === false
      ? formatPermissionConstraint(updatesAction.permissions)
      : undefined;
  const deleteReason =
    canDelete === false
      ? formatPermissionConstraint(deleteAction.permissions)
      : undefined;
  const updateReasonId = useId();
  const deleteReasonId = useId();
  // The values a reader scans this page for, in one row. The rest of the
  // record is behind the same link the header's Edit uses.
  const overviewFacts: OverviewFact[] = [
    {
      label: "Accessible to",
      value: (
        <ResourceVisibilityBadge
          scope={plugin.scope}
          teams={plugin.teams}
          users={plugin.users}
          authorId={plugin.authorId}
          authorName={undefined}
          currentUserId={currentUserId}
          showSelfAsMe
        />
      ),
    },
    {
      label: "Client",
      value: (
        <Badge variant="secondary" className="font-normal">
          {CLIENT_LABELS[plugin.clientType] ?? plugin.clientType}
        </Badge>
      ),
    },
    {
      label: "Platforms",
      value: (
        <span className="flex flex-wrap items-center gap-1.5">
          {plugin.supportedPlatforms.includes("posix") && (
            <Badge variant="outline" className="font-normal">
              macOS / Linux
            </Badge>
          )}
          {plugin.supportedPlatforms.includes("windows") && (
            <Badge variant="outline" className="font-normal">
              Windows
            </Badge>
          )}
        </span>
      ),
    },
    { label: "Source", value: <SourceFact plugin={plugin} /> },
  ];

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
      actionButton={
        <div className="flex shrink-0 items-center gap-2">
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
          <PermissionButton permissions={editAction.permissions} asChild>
            <Link href={pluginActionHref(editAction)}>
              <Pencil className="h-4 w-4" />
              {editAction.label}
            </Link>
          </PermissionButton>
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
                  aria-disabled={canUpdate !== true || undefined}
                  aria-describedby={updateReason ? updateReasonId : undefined}
                  className={
                    canUpdate === true
                      ? undefined
                      : "cursor-not-allowed opacity-50"
                  }
                  onSelect={(event) => {
                    if (canUpdate !== true) event.preventDefault();
                  }}
                  onClick={(event) => {
                    if (canUpdate !== true) {
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
      <div className="space-y-10">
        <OverviewSummary
          headingId="plugin-overview-heading"
          facts={overviewFacts}
          configHref={
            canUpdate === false ? undefined : pluginActionHref(editAction)
          }
        />

        <PluginCard title="Payload files" spacious>
          <SkillContentEditor
            manifest={null}
            files={plugin.files.map(({ path, content, encoding }) => ({
              path,
              content,
              encoding,
            }))}
            onManifestChange={noop}
            onFilesChange={noop}
            readOnly
            readOnlyMarker={false}
            className={SKILL_DETAIL_EDITOR_CLASS}
          />
        </PluginCard>
      </div>

      <DeleteConfirmDialog
        open={deleteRequested}
        onOpenChange={setDeleteRequested}
        title="Delete plugin?"
        description="It will disappear from future marketplace revisions. This does not uninstall code already present on developer machines; remove that plugin locally through the client or startup guard."
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

/** Where the plugin's content comes from. */
function SourceFact({ plugin }: { plugin: PluginDetail }) {
  const appName = useAppName();
  if (plugin.sourceKind !== "github") {
    return <span>Written in {appName}</span>;
  }
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <Github className="size-4 shrink-0 text-muted-foreground" />
      {plugin.sourceRepo ? (
        <a
          href={pluginSourceUrl(plugin) ?? undefined}
          target="_blank"
          rel="noreferrer"
          className="min-w-0 truncate font-mono underline underline-offset-4 hover:text-primary"
          title="Open the approved commit on GitHub"
        >
          {plugin.sourceMarketplaceRepo
            ? `${plugin.sourceMarketplaceRepo} · ${plugin.sourceMarketplacePluginName}`
            : plugin.sourceRepo}
          {plugin.sourceSha ? (
            <span className="text-muted-foreground">
              {" "}
              @ {plugin.sourceSha.slice(0, 10)}
            </span>
          ) : null}
        </a>
      ) : (
        <span>GitHub</span>
      )}
    </div>
  );
}

function pluginSourceUrl(plugin: PluginDetail): string | null {
  if (!plugin.sourceRepo) return null;
  return `https://github.com/${plugin.sourceRepo}${plugin.sourceSha ? `/commit/${plugin.sourceSha}` : ""}`;
}

function PluginCard({
  title,
  spacious = false,
  children,
}: {
  title: string;
  spacious?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="space-y-4 rounded-lg border bg-card p-4">
      <h2 className="text-base font-semibold tracking-tight text-foreground">
        {title}
      </h2>
      <div className={spacious ? "min-h-0" : undefined}>{children}</div>
    </section>
  );
}

const noop = () => {};

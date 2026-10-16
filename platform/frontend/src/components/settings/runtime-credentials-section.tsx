"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { AlertTriangle, Plus } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AccountPageAction } from "@/app/account/_components/account-page-action";
import { ClaudeCodeSubscription } from "@/app/account/_components/claude-code-subscription";
import { useSetSettingsAction } from "@/app/settings/layout";
import { AgentNameCell } from "@/components/agent-name-cell";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import {
  CollectionFilters,
  FilterBar,
  FilterSelect,
  filterSearchClass,
} from "@/components/filter-bar";
import { QueryLoadError } from "@/components/query-load-error";
import {
  RESOURCE_ACCESS_FILTER_PARAMS,
  ResourceAccessFilter,
  useResourceAccessParam,
} from "@/components/resource-access-filter";
import { ResourceListActions } from "@/components/resource-list-actions";
import { RuntimeCredentialActions } from "@/components/runtime-credential-actions";
import { RuntimeCredentialConnectionDialog } from "@/components/runtime-credential-connection-dialog";
import { RuntimeCredentialDisconnectDialog } from "@/components/runtime-credential-disconnect-dialog";
import {
  RuntimeCredentialIcon,
  runtimeCredentialIconOf,
} from "@/components/runtime-credential-icon";
import { SearchInput } from "@/components/search-input";
import { RuntimeCredentialDefinitionDialog } from "@/components/settings/runtime-credential-definition-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { PermissionButton } from "@/components/ui/permission-button";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useGitCredentials } from "@/lib/git-credentials.query";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import {
  type RuntimeCredentialDefinition,
  useDeleteRuntimeCredential,
  useDeleteRuntimeCredentialConnection,
  useFilteredRuntimeCredentials,
  useRuntimeCredentialUsage,
} from "@/lib/runtime-credentials.query";

/**
 * The credentials table of Settings → Credentials and, with `mode="personal"`,
 * of Personal Settings → Credentials. Each reader gets one of the two (see
 * `useCredentialsPage`): Settings for whoever can open it, Personal Settings
 * for everyone else. Both apply the same row rules and show the reader's
 * Claude Code sign-in above the table; the personal table lists only
 * credentials that take a personal value, offers no "Admin access" view of
 * other people's credentials, and adds credentials just for the reader.
 */
export function RuntimeCredentialsSection({
  mode = "organization",
}: {
  mode?: "organization" | "personal";
}) {
  const personalMode = mode === "personal";
  const {
    searchParams,
    pageIndex,
    pageSize,
    updateQueryParams,
    setPagination,
  } = useDataTableQueryParams({ defaultPageSize: 10 });
  const {
    access,
    sharedWith,
    owner,
    isDefault: isDefaultAccess,
  } = useResourceAccessParam({ offerAdminAccess: !personalMode });
  const definitions = useFilteredRuntimeCredentials({
    access,
    sharedWith,
    owner,
  });
  // GitLab tokens name their host here: the definition list does not carry it.
  const gitCredentials = useGitCredentials(
    definitions.data?.some((entry) => entry.kind === "gitlab_token") ?? false,
  );
  const gitHosts = useMemo(
    () =>
      new Map(
        (gitCredentials.data ?? []).map((entry) => [
          entry.id,
          new URL(entry.webUrl).host,
        ]),
      ),
    [gitCredentials.data],
  );
  const byosEnabled = useFeature("byosEnabled");
  const [definitionDialog, setDefinitionDialog] = useState<
    RuntimeCredentialDefinition | "new" | null
  >(null);
  const [connecting, setConnecting] =
    useState<RuntimeCredentialDefinition | null>(null);
  const [disconnecting, setDisconnecting] =
    useState<RuntimeCredentialDefinition | null>(null);
  const [deleting, setDeleting] = useState<RuntimeCredentialDefinition | null>(
    null,
  );
  const deleteDefinition = useDeleteRuntimeCredential();
  const disconnect = useDeleteRuntimeCredentialConnection();

  const setActionButton = useSetSettingsAction();
  // Settings → Credentials is the one credentials page for everyone who can
  // open it, so a reader there without credential:create (Settings reached
  // through a grant on one organization credential) still adds credentials
  // just for themselves, as in Personal Settings.
  const { data: canCreateShared } = useHasPermissions({
    credential: ["create"],
  });
  const personalCreate = personalMode || canCreateShared === false;
  const search = searchParams.get("search") ?? "";
  const kind = searchParams.get("kind") ?? "all";
  const scope = personalMode ? "all" : (searchParams.get("scope") ?? "all");
  const kindLabels = personalMode
    ? PERSONAL_CREDENTIAL_KIND_LABELS
    : CREDENTIAL_KIND_LABELS;
  const hasActiveFilters =
    Boolean(search.trim()) ||
    kind !== "all" ||
    scope !== "all" ||
    !isDefaultAccess;
  const clearFilters = () =>
    updateQueryParams({
      search: null,
      kind: null,
      scope: null,
      ...Object.fromEntries(
        RESOURCE_ACCESS_FILTER_PARAMS.map((param) => [param, null]),
      ),
      page: "1",
    });

  useEffect(() => {
    if (personalMode) return;
    setActionButton(
      <div className="flex items-center gap-2">
        {canCreateShared === false ? (
          <Button size="sm" onClick={() => setDefinitionDialog("new")}>
            <Plus className="size-4" />
            <span>Add credential</span>
          </Button>
        ) : (
          <PermissionButton
            permissions={{ credential: ["create"] }}
            size="sm"
            onClick={() => setDefinitionDialog("new")}
          >
            <Plus className="size-4" />
            <span>Add credential</span>
          </PermissionButton>
        )}
        <ResourceListActions resource="credential" />
      </div>,
    );
    return () => setActionButton(null);
  }, [setActionButton, personalMode, canCreateShared]);

  const filteredDefinitions = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (definitions.data ?? []).filter(
      (definition) =>
        (!personalMode || definition.allowPersonal) &&
        (!query ||
          [definition.name, definition.key, definition.description].some(
            (value) => value.toLowerCase().includes(query),
          )) &&
        (kind === "all" || definition.kind === kind) &&
        (scope === "all" ||
          (scope === "organization"
            ? definition.allowOrganization
            : definition.allowPersonal)),
    );
  }, [definitions.data, search, kind, scope, personalMode]);

  const columns = useMemo<ColumnDef<RuntimeCredentialDefinition>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Credential",
        size: 270,
        cell: ({ row: { original: definition } }) => (
          <AgentNameCell
            name={definition.name}
            description={definition.description}
            builtIn={definition.builtIn}
            icon={
              <RuntimeCredentialIcon
                icon={runtimeCredentialIconOf(definition)}
              />
            }
            extraBadges={
              (
                definition.allowOrganization
                  ? definition.organizationConfigured
                  : definition.personalConfigured
              ) ? (
                <Badge variant="secondary" className="font-normal">
                  Connected
                </Badge>
              ) : undefined
            }
          />
        ),
      },
      {
        accessorKey: "kind",
        header: "Type",
        size: 140,
        cell: ({ row }) => {
          const host =
            row.original.kind === "gitlab_token"
              ? gitHosts.get(row.original.id)
              : undefined;
          return (
            <span className="block min-w-0">
              <span className="block">
                {CREDENTIAL_KIND_LABELS[row.original.kind]}
              </span>
              {host ? (
                <span className="block truncate text-xs text-muted-foreground">
                  {host}
                </span>
              ) : null}
            </span>
          );
        },
      },
      // Every personal row would say "Each user".
      ...(personalMode
        ? []
        : [
            {
              id: "scope",
              header: "Provided by",
              size: 120,
              cell: ({ row }) =>
                row.original.allowOrganization ? "Organization" : "Each user",
            } satisfies ColumnDef<RuntimeCredentialDefinition>,
          ]),
      {
        id: "actions",
        header: "Actions",
        size: 100,
        cell: ({ row: { original: definition } }) => (
          <RuntimeCredentialActions
            definition={definition}
            scope={definition.allowOrganization ? "organization" : "personal"}
            onConnect={() => setConnecting(definition)}
            onDisconnect={() => setDisconnecting(definition)}
            onEdit={() => setDefinitionDialog(definition)}
            onDelete={() => setDeleting(definition)}
          />
        ),
      },
    ],
    [gitHosts, personalMode],
  );

  return (
    <>
      {personalMode && (
        <AccountPageAction>
          <Button size="sm" onClick={() => setDefinitionDialog("new")}>
            <Plus className="size-4" />
            <span>Add credential</span>
          </Button>
        </AccountPageAction>
      )}
      <ClaudeCodeSubscription />
      <CollectionFilters>
        <FilterBar
          onClearFilters={hasActiveFilters ? clearFilters : undefined}
          search={
            <SearchInput
              objectNamePlural="credentials"
              searchFields={["name", "key", "description"]}
              className={filterSearchClass}
              paramName="search"
            />
          }
        >
          <ResourceAccessFilter
            resource="credential"
            noun="credentials"
            offerAdminAccess={!personalMode}
          />
          <FilterSelect
            value={kind}
            onValueChange={(value) =>
              updateQueryParams({
                kind: value === "all" ? null : value,
                page: "1",
              })
            }
            placeholder="Filter by type"
            items={[
              { value: "all", label: "All types" },
              ...Object.entries(kindLabels).map(([value, label]) => ({
                value,
                label,
                content: (
                  <span className="flex items-center gap-2">
                    <RuntimeCredentialIcon
                      icon={
                        value === "secret"
                          ? null
                          : value === "gitlab_token"
                            ? "logo:gitlab"
                            : "logo:github"
                      }
                      className="size-4"
                    />
                    <span>{label}</span>
                  </span>
                ),
              })),
            ]}
          />
          {!personalMode && (
            <FilterSelect
              value={scope}
              onValueChange={(value) =>
                updateQueryParams({
                  scope: value === "all" ? null : value,
                  page: "1",
                })
              }
              placeholder="Filter by scope"
              items={[
                { value: "all", label: "All scopes" },
                { value: "organization", label: "Organization" },
                { value: "personal", label: "Each user (personal)" },
              ]}
            />
          )}
        </FilterBar>
      </CollectionFilters>
      {definitions.isError ? (
        <QueryLoadError
          title="Couldn't load credentials"
          error={definitions.error}
          onRetry={() => definitions.refetch()}
        />
      ) : (
        <DataTable
          columns={columns}
          data={filteredDefinitions}
          getRowId={(definition) => definition.key}
          isLoading={definitions.isPending}
          pagination={{
            pageIndex,
            pageSize,
            total: filteredDefinitions.length,
          }}
          onPaginationChange={setPagination}
          emptyMessage={
            personalMode ? "No personal credentials" : "No credentials yet"
          }
          emptyDescription={
            personalMode
              ? undefined
              : "Add a credential to make it available to agents, MCP servers, skills, and knowledge."
          }
          hasActiveFilters={hasActiveFilters}
          filteredEmptyMessage="No credentials match your filters"
          onClearFilters={clearFilters}
          fixedWidthColumnIds={["kind", "scope"]}
          flexibleColumnIds={["name"]}
        />
      )}
      {definitionDialog && (
        <RuntimeCredentialDefinitionDialog
          definition={definitionDialog === "new" ? null : definitionDialog}
          personal={personalCreate}
          onClose={() => setDefinitionDialog(null)}
          onCreated={async (id) => {
            setDefinitionDialog(null);
            const { data } = await definitions.refetch();
            const created = data?.find((entry) => entry.id === id);
            // A new secret has no value yet: connect the one the reader
            // provides here, the organization's for an organization
            // credential, yours for one just for you.
            if (
              created?.kind === "secret" &&
              (personalCreate || created.allowOrganization)
            )
              setConnecting(created);
          }}
        />
      )}
      {connecting && (
        <RuntimeCredentialConnectionDialog
          definition={connecting}
          scope={connecting.allowOrganization ? "organization" : "personal"}
          useExternalSecretsManager={byosEnabled}
          onClose={() => setConnecting(null)}
        />
      )}
      <RuntimeCredentialDisconnectDialog
        definition={disconnecting}
        scope={disconnecting?.allowOrganization ? "organization" : "personal"}
        open={disconnecting !== null}
        isPending={disconnect.isPending}
        onOpenChange={(open) => {
          if (!open) setDisconnecting(null);
        }}
        onConfirm={() => {
          if (!disconnecting) return;
          disconnect.mutate(
            {
              key: disconnecting.key,
              name: disconnecting.name,
              scope: disconnecting.allowOrganization
                ? "organization"
                : "personal",
            },
            { onSuccess: () => setDisconnecting(null) },
          );
        }}
      />
      <DeleteCredentialDialog
        definition={deleting}
        isPending={deleteDefinition.isPending}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        onConfirm={() => {
          if (!deleting) return;
          deleteDefinition.mutate(
            { key: deleting.key, name: deleting.name },
            { onSuccess: () => setDeleting(null) },
          );
        }}
      />
    </>
  );
}

function DeleteCredentialDialog({
  definition,
  isPending,
  onOpenChange,
  onConfirm,
}: {
  definition: RuntimeCredentialDefinition | null;
  isPending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const usage = useRuntimeCredentialUsage(
    definition?.key ?? null,
    definition !== null,
  );
  const agents = [
    ...(usage.data?.agents ?? []),
    ...(usage.data?.resources ?? []),
  ];
  const hasBlockingAgents = agents.length > 0;
  const confirmDisabled =
    usage.isPending || usage.isError || hasBlockingAgents || isPending;

  return (
    <DeleteConfirmDialog
      open={definition !== null}
      onOpenChange={onOpenChange}
      title="Delete credential?"
      description={
        <div className="space-y-3">
          {usage.isPending ? (
            <p>Checking where this credential is used...</p>
          ) : usage.isError ? (
            <p>Could not check credential usage. Try again before deleting.</p>
          ) : hasBlockingAgents ? (
            <>
              <p>Remove this credential from these resources first:</p>
              <div className="rounded-md border bg-muted/30 p-2">
                {agents.map((agent) => (
                  <Link
                    key={agent.id}
                    href={
                      "kind" in agent
                        ? agent.kind === "mcp"
                          ? "/mcp/registry"
                          : agent.kind === "knowledge"
                            ? "/knowledge/knowledge-bases"
                            : agent.kind === "skill"
                              ? "/skills"
                              : "/plugins"
                        : `/agents/${agent.id}`
                    }
                    className="block truncate rounded px-2 py-1 text-sm text-foreground hover:bg-muted"
                  >
                    {agent.name}
                  </Link>
                ))}
              </div>
            </>
          ) : (
            <p>
              {definition?.name ?? "This credential"} and its connected value
              will be permanently deleted.
            </p>
          )}
          {usage.isError && (
            <InlineNotice variant="error">
              <AlertTriangle />
              <InlineNoticeText>
                Deletion is disabled until the usage check succeeds.
              </InlineNoticeText>
            </InlineNotice>
          )}
        </div>
      }
      isPending={isPending}
      onConfirm={onConfirm}
      confirmDisabled={confirmDisabled}
    />
  );
}

const CREDENTIAL_KIND_LABELS: Record<
  RuntimeCredentialDefinition["kind"],
  string
> = {
  secret: "Custom secret",
  github_app: "GitHub App",
  github_app_user: "GitHub user credential",
  gitlab_token: "GitLab token",
};

/** The types that take a personal value: GitHub Apps and GitLab tokens are the organization's. */
const PERSONAL_CREDENTIAL_KIND_LABELS: Partial<typeof CREDENTIAL_KIND_LABELS> =
  {
    secret: CREDENTIAL_KIND_LABELS.secret,
    github_app_user: CREDENTIAL_KIND_LABELS.github_app_user,
  };

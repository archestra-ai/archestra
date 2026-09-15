"use client";

import type { Permissions } from "@archestra/shared";
import type { ColumnDef } from "@tanstack/react-table";
import {
  AlertTriangle,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Trash2,
  Unplug,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useSetSettingsAction } from "@/app/settings/layout";
import { AgentNameCell } from "@/components/agent-name-cell";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import {
  CollectionFilters,
  FilterBar,
  FilterSelect,
  filterSearchClass,
} from "@/components/filter-bar";
import { GitHubConnectButton } from "@/components/github-connect-button";
import { QueryLoadError } from "@/components/query-load-error";
import { RuntimeCredentialConnectionDialog } from "@/components/runtime-credential-connection-dialog";
import { RuntimeCredentialDisconnectDialog } from "@/components/runtime-credential-disconnect-dialog";
import { RuntimeCredentialIcon } from "@/components/runtime-credential-icon";
import { SearchInput } from "@/components/search-input";
import { RuntimeCredentialDefinitionDialog } from "@/components/settings/runtime-credential-definition-dialog";
import { TableRowActions } from "@/components/table-row-actions";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/ui/data-table";
import { PermissionButton } from "@/components/ui/permission-button";
import { useFeature } from "@/lib/config/config.query";
import {
  type RuntimeCredentialDefinition,
  useDeleteRuntimeCredential,
  useDeleteRuntimeCredentialConnection,
  useRuntimeCredentials,
  useRuntimeCredentialUsage,
} from "@/lib/runtime-credentials.query";

const MANAGE_CREDENTIALS_PERMISSION: Permissions = {
  credential: ["update"],
};

export function RuntimeCredentialsSection() {
  const definitions = useRuntimeCredentials();
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
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState("all");
  const [scope, setScope] = useState("all");
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 10 });
  const hasActiveFilters =
    Boolean(search.trim()) || kind !== "all" || scope !== "all";
  const resetPage = () =>
    setPagination((previous) => ({ ...previous, pageIndex: 0 }));
  const clearFilters = () => {
    setSearch("");
    setKind("all");
    setScope("all");
    resetPage();
  };

  useEffect(() => {
    setActionButton(
      <PermissionButton
        permissions={{ credential: ["create"] }}
        onClick={() => setDefinitionDialog("new")}
      >
        <Plus className="size-4" />
        <span>Add credential</span>
      </PermissionButton>,
    );
    return () => setActionButton(null);
  }, [setActionButton]);

  const filteredDefinitions = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (definitions.data ?? []).filter(
      (definition) =>
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
  }, [definitions.data, search, kind, scope]);

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
                icon={
                  definition.icon ??
                  (definition.kind === "github_app" ||
                  definition.kind === "github_app_user"
                    ? "logo:github"
                    : null)
                }
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
        cell: ({ row }) => CREDENTIAL_KIND_LABELS[row.original.kind],
      },
      {
        id: "scope",
        header: "Provided by",
        size: 120,
        cell: ({ row }) =>
          row.original.allowOrganization ? "Organization" : "Each user",
      },
      {
        id: "actions",
        header: "Actions",
        size: 180,
        cell: ({ row: { original: definition } }) => (
          <CredentialActions
            definition={definition}
            onConnect={() => setConnecting(definition)}
            onDisconnect={() => setDisconnecting(definition)}
            onEdit={() => setDefinitionDialog(definition)}
            onDelete={() => setDeleting(definition)}
          />
        ),
      },
    ],
    [],
  );

  return (
    <>
      <CollectionFilters>
        <FilterBar
          onClearFilters={hasActiveFilters ? clearFilters : undefined}
          search={
            <SearchInput
              objectNamePlural="credentials"
              searchFields={["name", "key", "description"]}
              className={filterSearchClass}
              syncQueryParams={false}
              value={search}
              onSearchChange={(value) => {
                setSearch(value);
                resetPage();
              }}
            />
          }
        >
          <FilterSelect
            value={kind}
            onValueChange={(value) => {
              setKind(value);
              resetPage();
            }}
            placeholder="Filter by type"
            items={[
              { value: "all", label: "All types" },
              ...Object.entries(CREDENTIAL_KIND_LABELS).map(
                ([value, label]) => ({
                  value,
                  label,
                  content: (
                    <span className="flex items-center gap-2">
                      <RuntimeCredentialIcon
                        icon={value === "secret" ? null : "logo:github"}
                        className="size-4"
                      />
                      <span>{label}</span>
                    </span>
                  ),
                }),
              ),
            ]}
          />
          <FilterSelect
            value={scope}
            onValueChange={(value) => {
              setScope(value);
              resetPage();
            }}
            placeholder="Filter by scope"
            items={[
              { value: "all", label: "All scopes" },
              { value: "organization", label: "Organization" },
              { value: "personal", label: "Each user (personal)" },
            ]}
          />
        </FilterBar>
      </CollectionFilters>
      {definitions.isError ? (
        <QueryLoadError
          title="Couldn't load credentials"
          onRetry={() => definitions.refetch()}
        />
      ) : (
        <DataTable
          columns={columns}
          data={filteredDefinitions}
          getRowId={(definition) => definition.key}
          isLoading={definitions.isPending}
          pagination={{ ...pagination, total: filteredDefinitions.length }}
          onPaginationChange={setPagination}
          emptyMessage="No credentials yet"
          emptyDescription="Add a credential to make it available to agents, MCP servers, skills, and knowledge."
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
          onClose={() => setDefinitionDialog(null)}
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

function CredentialActions({
  definition,
  onConnect,
  onDisconnect,
  onEdit,
  onDelete,
}: {
  definition: RuntimeCredentialDefinition;
  onConnect: () => void;
  onDisconnect: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const connected = definition.allowOrganization
    ? definition.organizationConfigured
    : definition.personalConfigured;
  const primaryActions = [
    {
      icon: connected ? (
        <RefreshCw className="size-4" />
      ) : (
        <Plug className="size-4" />
      ),
      label: connected ? "Replace" : "Connect",
      onClick: onConnect,
      permissions: definition.allowOrganization
        ? MANAGE_CREDENTIALS_PERMISSION
        : ({ credential: ["read"] } as Permissions),
    },
  ];
  const dropdownActions = [
    ...(!definition.builtIn
      ? [
          {
            icon: <Pencil className="size-4" />,
            label: "Edit",
            onClick: onEdit,
            permissions: MANAGE_CREDENTIALS_PERMISSION,
          },
        ]
      : []),
    ...(connected
      ? [
          {
            icon: <Unplug className="size-4" />,
            label: "Disconnect",
            onClick: onDisconnect,
            permissions: definition.allowOrganization
              ? MANAGE_CREDENTIALS_PERMISSION
              : ({ credential: ["read"] } as Permissions),
            variant: "destructive" as const,
          },
        ]
      : []),
    ...(!definition.builtIn
      ? [
          {
            icon: <Trash2 className="size-4" />,
            label: "Delete",
            onClick: onDelete,
            permissions: { credential: ["delete"] } as Permissions,
            variant: "destructive" as const,
          },
        ]
      : []),
  ];

  if (primaryActions.length === 0 && dropdownActions.length === 0) return null;
  return (
    <div className="flex items-center gap-2 self-end sm:self-auto">
      {definition.kind === "github_app_user" && (
        <GitHubConnectButton
          label={connected ? "Reconnect GitHub" : "Connect GitHub"}
          onClick={onConnect}
        />
      )}
      <TableRowActions
        actions={definition.kind === "github_app_user" ? [] : primaryActions}
        dropdownActions={dropdownActions}
        itemName={definition.name}
      />
    </div>
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
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-destructive">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span className="text-xs leading-5">
                Deletion is disabled until the usage check succeeds.
              </span>
            </div>
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
  github_app_user: "GitHub user connection",
};

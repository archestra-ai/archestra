"use client";

import {
  type archestraApiTypes,
  E2eTestId,
  getDeleteVirtualKeyButtonTestId,
  getVirtualKeyRowTestId,
} from "@archestra/shared";
import type { ColumnDef } from "@tanstack/react-table";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CreateVirtualKeyDialog,
  formatExpiration,
  getDefaultVirtualKeyScope,
  getVirtualKeyVisibilityOptions,
  type VirtualKeyScope,
  type VirtualKeyType,
  VirtualKeyVisibilityField,
} from "@/components/create-virtual-key-dialog";
import { useSetCredentialsAction } from "@/components/credentials-action-context";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { ExpirationDateTimeField } from "@/components/expiration-date-time-field";
import { FormDialog } from "@/components/form-dialog";
import { LlmProviderApiKeyDropdown } from "@/components/llm-provider-api-key-dropdown";
import type { LlmProviderApiKeyResponse } from "@/components/llm-provider-api-key-form";
import {
  formatProviderKeySummary,
  type ProviderApiKeyMap,
  providerApiKeyMapToArray,
} from "@/components/provider-key-mappings-field";
import { ProviderKeyAccessFields } from "@/components/proxy-auth-provider-key-fields";
import { QueryLoadError } from "@/components/query-load-error";
import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
import { SearchInput } from "@/components/search-input";
import { TableRowActions } from "@/components/table-row-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import {
  DialogBody,
  DialogForm,
  DialogStickyFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";
import { hasUnsavedChanges } from "@/components/unsaved-changes-guard-utils";
import type { VisibilityOption } from "@/components/visibility-selector";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import { useDialogUrlParam } from "@/lib/hooks/use-dialog-url-param";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { useTeams } from "@/lib/teams/team.query";
import {
  useAllVirtualApiKeys,
  useDeleteVirtualApiKey,
  useUpdateVirtualApiKey,
  useVirtualKey,
} from "@/lib/virtual-api-keys.query";

type VirtualKeyWithParent =
  archestraApiTypes.GetAllVirtualApiKeysResponses["200"]["data"][number];
const KEY_TYPE_LABEL: Record<VirtualKeyType, string> = {
  standard: "Standard",
  passthrough: "Passthrough",
};

export default function VirtualKeysPage() {
  const {
    searchParams,
    pageIndex,
    pageSize,
    offset,
    setPagination,
    updateQueryParams,
  } = useDataTableQueryParams();
  const search = searchParams.get("search") || "";
  const providerApiKeyIdFilter = searchParams.get("providerApiKeyId") || "all";
  const keyTypeFilter = searchParams.get("keyType") || "all";

  const {
    data: response,
    isPending,
    isLoadingError: isVirtualKeysLoadError,
    refetch: refetchVirtualKeys,
  } = useAllVirtualApiKeys({
    limit: pageSize,
    offset,
    search: search || undefined,
    providerApiKeyId:
      providerApiKeyIdFilter === "all" ? undefined : providerApiKeyIdFilter,
    keyType:
      keyTypeFilter === "all" ? undefined : (keyTypeFilter as VirtualKeyType),
    toastOnError: false,
  });
  const virtualKeys = response?.data ?? [];
  const paginationMeta = response?.pagination;

  const { data: apiKeys = [] } = useLlmProviderApiKeys();
  const { data: session } = useSession();
  const { data: canReadTeams } = useHasPermissions({ team: ["read"] });
  const { data: isVirtualKeyAdmin } = useHasPermissions({
    llmVirtualKey: ["admin"],
  });
  const { data: teams = [] } = useTeams({ enabled: !!canReadTeams });
  const defaultExpirationSeconds = useFeature(
    "virtualKeyDefaultExpirationSeconds",
  );

  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [createInitialKeyType, setCreateInitialKeyType] =
    useState<VirtualKeyType>("standard");

  // Deep link from the proxy connect dialog: ?create=true opens the create
  // dialog, ?create=passthrough opens it preset to a passthrough key. The
  // param is stripped so refresh/back doesn't re-open it.
  const createParam = searchParams.get("create");
  useEffect(() => {
    if (createParam !== "true" && createParam !== "passthrough") return;
    setCreateInitialKeyType(
      createParam === "passthrough" ? "passthrough" : "standard",
    );
    setIsCreateDialogOpen(true);
    updateQueryParams({ create: null });
  }, [createParam, updateQueryParams]);

  const editId = searchParams.get("edit");
  const { data: editKeyFromUrl } = useVirtualKey(editId ?? undefined);
  const {
    entity: editingKey,
    open: openEditDialog,
    close: closeEditDialog,
  } = useDialogUrlParam<VirtualKeyWithParent>({
    paramName: "edit",
    entityFromUrl: editKeyFromUrl ?? null,
  });
  const [providerApiKeyFilterOpen, setProviderApiKeyFilterOpen] =
    useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [deletingKey, setDeletingKey] = useState<VirtualKeyWithParent | null>(
    null,
  );

  const columns: ColumnDef<VirtualKeyWithParent>[] = useMemo(
    () => [
      {
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => (
          <span
            className="font-medium"
            data-testid={getVirtualKeyRowTestId(row.original.name)}
          >
            {row.original.name}
          </span>
        ),
      },
      {
        accessorKey: "tokenStart",
        header: "Token",
        cell: ({ row }) => (
          <code className="text-xs text-muted-foreground">
            {row.original.tokenStart}...
          </code>
        ),
      },
      {
        id: "keyType",
        header: "Type",
        cell: ({ row }) => (
          <Badge
            variant={
              row.original.keyType === "passthrough" ? "outline" : "secondary"
            }
          >
            {KEY_TYPE_LABEL[row.original.keyType]}
          </Badge>
        ),
      },
      {
        id: "accessibleTo",
        header: "Accessible to",
        cell: ({ row }) => (
          <ResourceVisibilityBadge
            scope={row.original.scope as VirtualKeyScope | undefined}
            teams={row.original.teams}
            authorId={row.original.authorId}
            authorName={row.original.authorName}
            currentUserId={session?.user?.id}
            // The "Accessible to" column also lists team- and org-scoped keys, so
            // label the current user's own personal key "Me" (rather than leaving
            // it blank) to keep every row consistently attributed.
            showSelfAsMe
          />
        ),
      },
      {
        id: "providerKeys",
        header: "Provider Keys",
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">
            {row.original.keyType === "passthrough"
              ? "N/A"
              : formatProviderKeySummary(row.original.providerApiKeys)}
          </span>
        ),
      },
      {
        accessorKey: "expiresAt",
        header: "Expires",
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">
            {formatExpiration(row.original.expiresAt)}
          </span>
        ),
      },
      {
        accessorKey: "lastUsedAt",
        header: "Last Used",
        cell: ({ row }) =>
          row.original.lastUsedAt ? (
            <span className="text-sm text-muted-foreground">
              {new Date(row.original.lastUsedAt).toLocaleDateString()}
            </span>
          ) : (
            <span className="text-sm text-muted-foreground">Never</span>
          ),
      },
      {
        id: "actions",
        header: "Actions",
        cell: ({ row }) => (
          <TableRowActions
            actions={[
              {
                icon: <Pencil className="h-4 w-4" />,
                label: "Edit",
                onClick: () => openEditDialog(row.original),
              },
              {
                icon: <Trash2 className="h-4 w-4" />,
                label: "Delete",
                variant: "destructive",
                testId: getDeleteVirtualKeyButtonTestId(row.original.name),
                onClick: () => {
                  setDeletingKey(row.original);
                  setIsDeleteDialogOpen(true);
                },
              },
            ]}
          />
        ),
      },
    ],
    [session?.user?.id, openEditDialog],
  );

  const parentableKeys = apiKeys;

  const visibilityOptions = useMemo(
    () =>
      getVirtualKeyVisibilityOptions({
        canReadTeams: !!canReadTeams,
        isAdmin: !!isVirtualKeyAdmin,
      }),
    [canReadTeams, isVirtualKeyAdmin],
  );

  const setCredentialsAction = useSetCredentialsAction();
  useEffect(() => {
    setCredentialsAction(
      <Button
        onClick={() => setIsCreateDialogOpen(true)}
        data-testid={E2eTestId.AddVirtualKeyButton}
      >
        <Plus className="h-4 w-4" />
        Create Virtual Key
      </Button>,
    );
    return () => setCredentialsAction(null);
  }, [setCredentialsAction]);

  return (
    <>
      <div
        className="mb-4 flex flex-wrap gap-4"
        data-testid={E2eTestId.VirtualKeysPage}
      >
        <SearchInput
          objectNamePlural="virtual keys"
          searchFields={["name"]}
          paramName="search"
        />
        <LlmProviderApiKeyDropdown
          availableKeys={parentableKeys}
          selectedApiKeyId={
            providerApiKeyIdFilter === "all" ? null : providerApiKeyIdFilter
          }
          open={providerApiKeyFilterOpen}
          onOpenChange={setProviderApiKeyFilterOpen}
          onSelectKey={(value) => {
            updateQueryParams({
              providerApiKeyId: value,
              page: "1",
            });
            setProviderApiKeyFilterOpen(false);
          }}
          triggerVariant="select"
          triggerClassName="w-full sm:w-[280px] h-9 text-sm"
          popoverClassName="w-[var(--radix-popover-trigger-width)]"
          allOptionLabel="All provider API keys"
          allOptionSelected={providerApiKeyIdFilter === "all"}
          onSelectAllOption={() => {
            updateQueryParams({
              providerApiKeyId: null,
              page: "1",
            });
            setProviderApiKeyFilterOpen(false);
          }}
        />
        <Select
          value={keyTypeFilter}
          onValueChange={(value) =>
            updateQueryParams({
              keyType: value === "all" ? null : value,
              page: "1",
            })
          }
        >
          <SelectTrigger className="h-9 w-full text-sm sm:w-[200px]">
            <SelectValue placeholder="All key types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All key types</SelectItem>
            <SelectItem value="standard">Standard</SelectItem>
            <SelectItem value="passthrough">Passthrough</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isVirtualKeysLoadError ? (
        <QueryLoadError
          title="Couldn't load your virtual keys"
          onRetry={() => refetchVirtualKeys()}
        />
      ) : (
        <DataTable
          columns={columns}
          data={virtualKeys}
          getRowId={(row) => row.id}
          hideSelectedCount
          isLoading={isPending}
          emptyMessage={
            parentableKeys.length === 0
              ? "Add an API key first to create virtual keys"
              : "No virtual keys yet"
          }
          manualPagination
          pagination={{
            pageIndex,
            pageSize,
            total: paginationMeta?.total ?? 0,
          }}
          onPaginationChange={setPagination}
          hasActiveFilters={Boolean(
            search ||
              providerApiKeyIdFilter !== "all" ||
              keyTypeFilter !== "all",
          )}
          filteredEmptyMessage="No virtual keys match your filters. Try adjusting your search."
          onClearFilters={() =>
            updateQueryParams({
              search: null,
              providerApiKeyId: null,
              keyType: null,
              page: "1",
            })
          }
        />
      )}

      <CreateVirtualKeyDialog
        open={isCreateDialogOpen}
        onOpenChange={(open) => {
          setIsCreateDialogOpen(open);
          if (!open) setCreateInitialKeyType("standard");
        }}
        initialKeyType={createInitialKeyType}
        parentableKeys={parentableKeys}
        defaultExpirationSeconds={defaultExpirationSeconds ?? null}
        visibilityOptions={visibilityOptions}
        teams={teams}
        canReadTeams={!!canReadTeams}
        isVirtualKeyAdmin={!!isVirtualKeyAdmin}
      />

      <EditVirtualKeyDialog
        open={!!editingKey}
        onOpenChange={(open) => !open && closeEditDialog()}
        virtualKey={editingKey}
        providerApiKeys={parentableKeys}
        visibilityOptions={visibilityOptions}
        teams={teams}
        canReadTeams={!!canReadTeams}
      />

      <DeleteVirtualKeyDialog
        open={isDeleteDialogOpen}
        onOpenChange={setIsDeleteDialogOpen}
        virtualKey={deletingKey}
      />
    </>
  );
}

function EditVirtualKeyDialog({
  open,
  onOpenChange,
  virtualKey,
  providerApiKeys,
  visibilityOptions,
  teams,
  canReadTeams,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  virtualKey: VirtualKeyWithParent | null;
  providerApiKeys: LlmProviderApiKeyResponse[];
  visibilityOptions: VisibilityOption<VirtualKeyScope>[];
  teams: Array<{ id: string; name: string }>;
  canReadTeams: boolean;
}) {
  const updateMutation = useUpdateVirtualApiKey();
  const [name, setName] = useState("");
  const [expiresAt, setExpiresAt] = useState<Date | null>(null);
  const [scope, setScope] = useState<VirtualKeyScope>(
    getDefaultVirtualKeyScope(visibilityOptions),
  );
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [providerApiKeyIds, setProviderApiKeyIds] = useState<ProviderApiKeyMap>(
    {},
  );
  const initialSnapshotRef = useRef<Record<string, unknown> | null>(null);

  useEffect(() => {
    if (!open || !virtualKey) {
      return;
    }

    const initialName = virtualKey.name;
    const initialExpiresAt = virtualKey.expiresAt
      ? new Date(virtualKey.expiresAt)
      : null;
    const initialScope = (virtualKey.scope as VirtualKeyScope) ?? "personal";
    const initialTeamIds = virtualKey.teams.map((team) => team.id);
    const initialProviderApiKeyIds = Object.fromEntries(
      virtualKey.providerApiKeys.map((mapping) => [
        mapping.provider,
        mapping.providerApiKeyId,
      ]),
    );

    setName(initialName);
    setExpiresAt(initialExpiresAt);
    setScope(initialScope);
    setTeamIds(initialTeamIds);
    setProviderApiKeyIds(initialProviderApiKeyIds);
    initialSnapshotRef.current = {
      name: initialName,
      expiresAt: initialExpiresAt,
      scope: initialScope,
      teamIds: [...initialTeamIds].sort(),
      providerApiKeyIds: initialProviderApiKeyIds,
    };
  }, [open, virtualKey]);

  // The key type is fixed at creation; only its own configuration is editable.
  const isPassthrough = virtualKey?.keyType === "passthrough";

  const handleUpdate = useCallback(async () => {
    if (!virtualKey || !name.trim()) {
      return;
    }

    try {
      const result = await updateMutation.mutateAsync({
        id: virtualKey.id,
        data: isPassthrough
          ? {
              name: name.trim(),
              keyType: "passthrough",
              expiresAt: expiresAt ?? undefined,
            }
          : {
              name: name.trim(),
              keyType: "standard",
              expiresAt: expiresAt ?? undefined,
              scope,
              teams: scope === "team" ? teamIds : [],
              providerApiKeys: providerApiKeyMapToArray(providerApiKeyIds),
            },
      });

      if (result) {
        onOpenChange(false);
      }
    } catch {
      // handled by mutation
    }
  }, [
    expiresAt,
    isPassthrough,
    providerApiKeyIds,
    name,
    onOpenChange,
    scope,
    teamIds,
    updateMutation,
    virtualKey,
  ]);

  if (!virtualKey) {
    return null;
  }

  const standardReady =
    (scope !== "team" || teamIds.length > 0) &&
    providerApiKeyMapToArray(providerApiKeyIds).length > 0;
  const canSubmit =
    name.trim().length > 0 &&
    (isPassthrough || standardReady) &&
    !updateMutation.isPending;
  const isDirty =
    initialSnapshotRef.current !== null &&
    hasUnsavedChanges(initialSnapshotRef.current, {
      name,
      expiresAt,
      scope,
      teamIds: [...teamIds].sort(),
      providerApiKeyIds,
    });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Edit Virtual API Key"
      description={
        isPassthrough
          ? "Update the passthrough key name and expiration."
          : "Update the virtual key name, visibility, and expiration."
      }
      size="medium"
      isDirty={isDirty}
    >
      <DialogForm onSubmit={handleUpdate}>
        <DialogBody className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="edit-virtual-key-name">Name</Label>
            <Input
              id="edit-virtual-key-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="My virtual key"
            />
          </div>

          {isPassthrough ? (
            <div className="space-y-2">
              <ExpirationDateTimeField
                value={expiresAt}
                onChange={setExpiresAt}
                noExpirationText="Key will never expire"
                formatExpiration={formatExpiration}
              />
            </div>
          ) : (
            <>
              <VirtualKeyVisibilityField
                value={scope}
                onValueChange={(nextScope) => {
                  setScope(nextScope);
                  if (nextScope !== "team") {
                    setTeamIds([]);
                  }
                }}
                teamIds={teamIds}
                onTeamIdsChange={setTeamIds}
                teams={teams}
                canReadTeams={canReadTeams}
                visibilityOptions={visibilityOptions}
              />

              <div className="space-y-2">
                <ExpirationDateTimeField
                  value={expiresAt}
                  onChange={setExpiresAt}
                  noExpirationText="Key will never expire"
                  formatExpiration={formatExpiration}
                />
              </div>

              <ProviderKeyAccessFields
                providerApiKeyIds={providerApiKeyIds}
                onProviderApiKeyIdsChange={setProviderApiKeyIds}
                providerApiKeys={providerApiKeys}
              />
            </>
          )}
        </DialogBody>
        <DialogStickyFooter className="mt-0">
          <DialogCancelButton>Cancel</DialogCancelButton>
          <Button type="submit" disabled={!canSubmit}>
            {updateMutation.isPending && (
              <Loader2 className="h-4 w-4 animate-spin" />
            )}
            Save Changes
          </Button>
        </DialogStickyFooter>
      </DialogForm>
    </FormDialog>
  );
}

function DeleteVirtualKeyDialog({
  open,
  onOpenChange,
  virtualKey,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  virtualKey: VirtualKeyWithParent | null;
}) {
  const deleteMutation = useDeleteVirtualApiKey();

  return (
    <DeleteConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Delete Virtual Key"
      description={
        <div data-testid={E2eTestId.VirtualKeyDeleteDialog}>
          Are you sure you want to delete "{virtualKey?.name}"? This action
          cannot be undone.
        </div>
      }
      confirmLabel="Delete"
      isPending={deleteMutation.isPending}
      onConfirm={() => {
        if (!virtualKey) return;

        deleteMutation.mutate(
          {
            id: virtualKey.id,
          },
          {
            onSuccess: () => {
              onOpenChange(false);
            },
          },
        );
      }}
    />
  );
}

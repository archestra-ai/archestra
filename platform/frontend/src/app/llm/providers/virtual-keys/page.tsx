"use client";

import {
  type archestraApiTypes,
  E2eTestId,
  getDeleteVirtualKeyButtonTestId,
  getVirtualKeyRowTestId,
} from "@shared";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Globe,
  Key,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  User,
  Users,
} from "lucide-react";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CopyableCode } from "@/components/copyable-code";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { ExpirationDateTimeField } from "@/components/expiration-date-time-field";
import { FormDialog } from "@/components/form-dialog";
import {
  type LlmProviderApiKeyResponse,
  PROVIDER_CONFIG,
} from "@/components/llm-provider-api-key-form";
import {
  LlmProviderApiKeyFilterSelect,
  LlmProviderApiKeySelectItems,
} from "@/components/llm-provider-options";
import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
import { SearchInput } from "@/components/search-input";
import { TableRowActions } from "@/components/table-row-actions";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import {
  DialogBody,
  DialogForm,
  DialogStickyFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MultiSelectCombobox } from "@/components/ui/multi-select-combobox";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  type VisibilityOption,
  VisibilitySelector,
} from "@/components/visibility-selector";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { authClient } from "@/lib/clients/auth/auth-client";
import { useFeature } from "@/lib/config/config.query";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { useTeams } from "@/lib/teams/team.query";
import { formatRelativeTime } from "@/lib/utils/date-time";
import {
  useAllVirtualApiKeys,
  useCreateVirtualApiKey,
  useDeleteVirtualApiKey,
  useUpdateVirtualApiKey,
} from "@/lib/virtual-api-keys.query";
import { useSetProviderAction } from "../layout";

type VirtualKeyWithParent =
  archestraApiTypes.GetAllVirtualApiKeysResponses["200"]["data"][number];
type VirtualKeyScope = NonNullable<
  archestraApiTypes.CreateVirtualApiKeyData["body"]["scope"]
>;

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
  const chatApiKeyIdFilter = searchParams.get("chatApiKeyId") || "all";

  const { data: response, isPending } = useAllVirtualApiKeys({
    limit: pageSize,
    offset,
    search: search || undefined,
    chatApiKeyId: chatApiKeyIdFilter === "all" ? undefined : chatApiKeyIdFilter,
  });
  const virtualKeys = response?.data ?? [];
  const paginationMeta = response?.pagination;

  const { data: apiKeys = [] } = useLlmProviderApiKeys();
  const { data: session } = authClient.useSession();
  const { data: canReadTeams } = useHasPermissions({ team: ["read"] });
  const { data: isVirtualKeyAdmin } = useHasPermissions({
    llmVirtualKey: ["admin"],
  });
  const { data: teams = [] } = useTeams({ enabled: !!canReadTeams });
  const defaultExpirationSeconds = useFeature(
    "virtualKeyDefaultExpirationSeconds",
  );

  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [editingKey, setEditingKey] = useState<VirtualKeyWithParent | null>(
    null,
  );
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
        id: "accessibleTo",
        header: "Accessible to",
        cell: ({ row }) => (
          <ResourceVisibilityBadge
            scope={row.original.scope as VirtualKeyScope | undefined}
            teams={row.original.teams}
            authorId={row.original.authorId}
            authorName={row.original.authorName}
            currentUserId={session?.user?.id}
          />
        ),
      },
      {
        accessorKey: "parentKeyName",
        header: "Provider API Key",
        cell: ({ row }) => {
          const provider = row.original
            .parentKeyProvider as LlmProviderApiKeyResponse["provider"];
          const config = PROVIDER_CONFIG[provider];
          return (
            <div className="flex items-center gap-2">
              {config && (
                <Image
                  src={config.icon}
                  alt={config.name}
                  width={16}
                  height={16}
                  className="rounded dark:invert"
                />
              )}
              <span className="text-sm">{row.original.parentKeyName}</span>
            </div>
          );
        },
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
                onClick: () => setEditingKey(row.original),
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
    [session?.user?.id],
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

  const setProviderAction = useSetProviderAction();
  useEffect(() => {
    setProviderAction(
      <Button
        onClick={() => setIsCreateDialogOpen(true)}
        disabled={parentableKeys.length === 0}
        data-testid={E2eTestId.AddVirtualKeyButton}
      >
        <Plus className="h-4 w-4 mr-2" />
        Create Virtual Key
      </Button>,
    );
    return () => setProviderAction(null);
  }, [setProviderAction, parentableKeys.length]);

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
        <LlmProviderApiKeyFilterSelect
          value={chatApiKeyIdFilter}
          onValueChange={(value) =>
            updateQueryParams({
              chatApiKeyId: value === "all" ? null : value,
              page: "1",
            })
          }
          allLabel="All provider API keys"
          options={parentableKeys.map((key) => {
            const config = PROVIDER_CONFIG[key.provider];
            return {
              value: key.id,
              icon: config.icon,
              providerName: config.name,
              keyName: key.name,
            };
          })}
        />
      </div>

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
        hasActiveFilters={Boolean(search || chatApiKeyIdFilter !== "all")}
        filteredEmptyMessage="No virtual keys match your filters. Try adjusting your search."
        onClearFilters={() =>
          updateQueryParams({
            search: null,
            chatApiKeyId: null,
            page: "1",
          })
        }
      />

      <CreateVirtualKeyDialog
        open={isCreateDialogOpen}
        onOpenChange={setIsCreateDialogOpen}
        parentableKeys={parentableKeys}
        defaultExpirationSeconds={defaultExpirationSeconds ?? null}
        visibilityOptions={visibilityOptions}
        teams={teams}
        canReadTeams={!!canReadTeams}
      />

      <EditVirtualKeyDialog
        open={!!editingKey}
        onOpenChange={(open) => !open && setEditingKey(null)}
        virtualKey={editingKey}
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

function CreateVirtualKeyDialog({
  open,
  onOpenChange,
  parentableKeys,
  defaultExpirationSeconds,
  visibilityOptions,
  teams,
  canReadTeams,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  parentableKeys: LlmProviderApiKeyResponse[];
  defaultExpirationSeconds: number | null;
  visibilityOptions: VisibilityOption<VirtualKeyScope>[];
  teams: Array<{ id: string; name: string }>;
  canReadTeams: boolean;
}) {
  const createMutation = useCreateVirtualApiKey();

  const [newKeyName, setNewKeyName] = useState("");
  const [selectedParentKeyId, setSelectedParentKeyId] = useState<string>("");
  const [expiresAt, setExpiresAt] = useState<Date | null>(null);
  const [scope, setScope] = useState<VirtualKeyScope>(
    getDefaultVirtualKeyScope(visibilityOptions),
  );
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [createdKeyValue, setCreatedKeyValue] = useState<string | null>(null);
  const [createdKeyExpiresAt, setCreatedKeyExpiresAt] = useState<Date | null>(
    null,
  );

  const defaultParentKeyId = parentableKeys[0]?.id ?? "";
  const prevOpenRef = useRef(open);

  useEffect(() => {
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;
    if (open && !wasOpen) {
      setCreatedKeyValue(null);
      setCreatedKeyExpiresAt(null);
      setNewKeyName("");
      setSelectedParentKeyId(defaultParentKeyId);
      setExpiresAt(computeDefaultExpiresAt(defaultExpirationSeconds));
      setScope(getDefaultVirtualKeyScope(visibilityOptions));
      setTeamIds([]);
    }
  }, [open, defaultParentKeyId, defaultExpirationSeconds, visibilityOptions]);

  const handleCreate = useCallback(async () => {
    if (!newKeyName.trim() || !selectedParentKeyId) return;
    try {
      const result = await createMutation.mutateAsync({
        chatApiKeyId: selectedParentKeyId,
        data: {
          name: newKeyName.trim(),
          expiresAt: expiresAt ?? undefined,
          scope,
          teams: scope === "team" ? teamIds : [],
        },
      });
      setNewKeyName("");
      if (result?.value) {
        setCreatedKeyValue(result.value);
        setCreatedKeyExpiresAt(expiresAt);
      }
    } catch {
      // handled by mutation
    }
  }, [
    createMutation,
    expiresAt,
    newKeyName,
    scope,
    selectedParentKeyId,
    teamIds,
  ]);

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        createdKeyValue ? "Virtual API Key Created" : "Create Virtual API Key"
      }
      description={
        createdKeyValue
          ? undefined
          : "Create a virtual key linked to one of your provider API keys"
      }
      size="small"
    >
      <DialogForm onSubmit={handleCreate}>
        <DialogBody
          className="space-y-4"
          data-testid={E2eTestId.VirtualKeyCreateDialog}
        >
          {createdKeyValue ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Key className="h-4 w-4" />
                Copy this key now. It won&apos;t be shown again.
              </div>
              <div data-testid={E2eTestId.VirtualKeyValue}>
                <CopyableCode value={createdKeyValue} />
              </div>
              <div className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">Expires:</span>{" "}
                {formatExpiration(createdKeyExpiresAt)}
              </div>
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <Label>Provider API Key</Label>
                <Select
                  value={selectedParentKeyId}
                  onValueChange={setSelectedParentKeyId}
                >
                  <SelectTrigger
                    className="w-full"
                    data-testid={E2eTestId.VirtualKeyParentKeySelect}
                  >
                    <SelectValue placeholder="Select an API key" />
                  </SelectTrigger>
                  <SelectContent>
                    <LlmProviderApiKeySelectItems
                      options={parentableKeys.map((key) => {
                        const config = PROVIDER_CONFIG[key.provider];
                        return {
                          value: key.id,
                          icon: config.icon,
                          providerName: config.name,
                          keyName: key.name,
                          secondaryLabel: config.name,
                        };
                      })}
                    />
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="virtual-key-name">Name</Label>
                <Input
                  id="virtual-key-name"
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                  placeholder="My virtual key"
                />
              </div>

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
            </>
          )}
        </DialogBody>
        <DialogStickyFooter className="mt-0">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {createdKeyValue ? "Close" : "Cancel"}
          </Button>
          {!createdKeyValue && (
            <Button
              type="submit"
              disabled={
                !newKeyName.trim() ||
                !selectedParentKeyId ||
                (scope === "team" && teamIds.length === 0) ||
                createMutation.isPending
              }
            >
              {createMutation.isPending && (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              )}
              Create
            </Button>
          )}
        </DialogStickyFooter>
      </DialogForm>
    </FormDialog>
  );
}

function EditVirtualKeyDialog({
  open,
  onOpenChange,
  virtualKey,
  visibilityOptions,
  teams,
  canReadTeams,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  virtualKey: VirtualKeyWithParent | null;
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

  useEffect(() => {
    if (!open || !virtualKey) {
      return;
    }

    setName(virtualKey.name);
    setExpiresAt(virtualKey.expiresAt ? new Date(virtualKey.expiresAt) : null);
    setScope((virtualKey.scope as VirtualKeyScope) ?? "personal");
    setTeamIds(virtualKey.teams.map((team) => team.id));
  }, [open, virtualKey]);

  const handleUpdate = useCallback(async () => {
    if (!virtualKey || !name.trim()) {
      return;
    }

    try {
      const result = await updateMutation.mutateAsync({
        chatApiKeyId: virtualKey.chatApiKeyId,
        id: virtualKey.id,
        data: {
          name: name.trim(),
          expiresAt: expiresAt ?? undefined,
          scope,
          teams: scope === "team" ? teamIds : [],
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

  const providerConfig =
    PROVIDER_CONFIG[
      virtualKey.parentKeyProvider as LlmProviderApiKeyResponse["provider"]
    ];

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Edit Virtual API Key"
      description="Update the virtual key name, visibility, and expiration."
      size="small"
    >
      <DialogForm onSubmit={handleUpdate}>
        <DialogBody className="space-y-4">
          <div className="space-y-2">
            <Label>Provider API Key</Label>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              {providerConfig && (
                <Image
                  src={providerConfig.icon}
                  alt={providerConfig.name}
                  width={16}
                  height={16}
                  className="rounded dark:invert"
                />
              )}
              <span>{virtualKey.parentKeyName}</span>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="edit-virtual-key-name">Name</Label>
            <Input
              id="edit-virtual-key-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="My virtual key"
            />
          </div>

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
        </DialogBody>
        <DialogStickyFooter className="mt-0">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={
              !name.trim() ||
              (scope === "team" && teamIds.length === 0) ||
              updateMutation.isPending
            }
          >
            {updateMutation.isPending && (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
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
            chatApiKeyId: virtualKey.chatApiKeyId,
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

function VirtualKeyVisibilityField({
  value,
  onValueChange,
  teamIds,
  onTeamIdsChange,
  teams,
  canReadTeams,
  visibilityOptions,
}: {
  value: VirtualKeyScope;
  onValueChange: (value: VirtualKeyScope) => void;
  teamIds: string[];
  onTeamIdsChange: (value: string[]) => void;
  teams: Array<{ id: string; name: string }>;
  canReadTeams: boolean;
  visibilityOptions: VisibilityOption<VirtualKeyScope>[];
}) {
  return (
    <VisibilitySelector
      heading="Who can use this virtual key"
      value={value}
      options={visibilityOptions}
      onValueChange={onValueChange}
    >
      {value === "team" && (
        <div className="space-y-2">
          <Label>Teams</Label>
          <MultiSelectCombobox
            disabled={!canReadTeams}
            options={teams.map((team) => ({
              value: team.id,
              label: team.name,
            }))}
            value={teamIds}
            onChange={onTeamIdsChange}
            placeholder={canReadTeams ? "Search teams..." : "Teams unavailable"}
            emptyMessage="No teams found."
          />
        </div>
      )}
    </VisibilitySelector>
  );
}

function formatExpiration(date: Date | string | null): string {
  return formatRelativeTime(date);
}

function computeDefaultExpiresAt(defaultSeconds: number | null): Date | null {
  if (defaultSeconds === null) return null;
  return new Date(Date.now() + defaultSeconds * 1000);
}

function getDefaultVirtualKeyScope(
  visibilityOptions: VisibilityOption<VirtualKeyScope>[],
): VirtualKeyScope {
  return (
    visibilityOptions.find((option) => !option.disabled)?.value ?? "personal"
  );
}

function getVirtualKeyVisibilityOptions(params: {
  isAdmin: boolean;
  canReadTeams: boolean;
}): VisibilityOption<VirtualKeyScope>[] {
  const { isAdmin, canReadTeams } = params;

  return [
    {
      value: "personal",
      label: "Personal",
      description: "Only you can view and manage this virtual key",
      icon: User,
    },
    {
      value: "team",
      label: "Team",
      description: "Visible to selected teams",
      icon: Users,
      disabled: !canReadTeams,
      disabledReason: !canReadTeams
        ? "Team sharing is unavailable without team:read permission"
        : undefined,
    },
    {
      value: "org",
      label: "Organization",
      description: "Visible to everyone in the organization",
      icon: Globe,
      disabled: !isAdmin,
      disabledReason: !isAdmin
        ? "You need llmVirtualKey:admin permission to share org-wide"
        : undefined,
    },
  ];
}

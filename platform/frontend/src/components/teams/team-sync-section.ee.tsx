// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import {
  archestraApiSdk,
  type archestraApiTypes,
  DocsPage,
  E2eTestId,
  getDocsUrl,
  MEMBER_ROLE_NAME,
} from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Check, Plus, Trash2, X } from "lucide-react";
import Link from "next/link";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { TableRowActions } from "@/components/table-row-actions";
import { DataTable } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useTeamSyncIdentityProviderOptions } from "@/lib/auth/identity-provider.query.ee";
import { TeamMemberRoleSelect } from "./team-member-role-select";

export function TeamSyncSection({
  open,
  team,
  readOnly = false,
}: {
  open: boolean;
  team: Team;
  /**
   * View-only rendering for callers with identity-provider read access but no
   * team management rights: links are listed without add/remove controls.
   */
  readOnly?: boolean;
}) {
  const queryClient = useQueryClient();
  // Minimal team-sync projection (team:read) rather than the full provider
  // configuration, so team admins without identityProvider:read can link
  // groups to their team.
  const { data: providers = [] } = useTeamSyncIdentityProviderOptions({
    enabled: open,
  });
  const { data: canCreateIdentityProviders = false } = useHasPermissions({
    identityProvider: ["create"],
  });
  const { data: groups = [], isLoading } = useQuery({
    queryKey: ["teamExternalGroups", team.id],
    queryFn: async () => {
      const { data } = await archestraApiSdk.getTeamExternalGroups({
        path: { id: team.id },
      });
      return data ?? [];
    },
    enabled: open,
  });

  const invalidateGroups = () =>
    queryClient.invalidateQueries({
      queryKey: ["teamExternalGroups", team.id],
    });
  const linkMutation = useMutation({
    mutationFn: async (link: LinkBody) => {
      const { error } = await archestraApiSdk.addTeamExternalGroup({
        path: { id: team.id },
        body: link,
      });
      if (error) throw new Error(error.error.message);
    },
    onSuccess: () => {
      invalidateGroups();
      draft.close();
      toast.success("Group linked");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to link group");
    },
  });
  const unlinkMutation = useMutation({
    mutationFn: async (groupId: string) => {
      const { error } = await archestraApiSdk.removeTeamExternalGroup({
        path: { id: team.id, groupId },
      });
      if (error) throw new Error(error.error.message);
    },
    onSuccess: () => {
      invalidateGroups();
      toast.success("Group unlinked");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to unlink group");
    },
  });

  const draft = useDraftState({
    providers,
    groups,
    busy: linkMutation.isPending,
    onLink: (link) => linkMutation.mutate(link),
  });
  const canLink = !readOnly && providers.length > 0;
  const busy = linkMutation.isPending || unlinkMutation.isPending;

  // Cells read the latest values through refs so the columns, and the draft
  // input inside them, stay mounted while typing.
  const latest = useRef({ providers, busy, unlink: unlinkMutation.mutate });
  latest.current = { providers, busy, unlink: unlinkMutation.mutate };
  const columns = useMemo<ColumnDef<Row>[]>(
    () => [
      {
        id: "provider",
        header: "Identity provider",
        size: 200,
        cell: ({ row }) => {
          const value = row.original;
          if (value.kind === "add") {
            return <AddGroupRowButton empty={groups.length === 0} />;
          }
          if (value.kind === "draft") return <DraftProviderCell />;
          return (
            <span className="block truncate">
              {providerLabel(
                latest.current.providers,
                value.group.identityProviderId,
              )}
            </span>
          );
        },
      },
      {
        id: "identifier",
        header: "Group identifier",
        cell: ({ row }) => {
          const value = row.original;
          if (value.kind === "add") return null;
          if (value.kind === "draft") return <DraftIdentifierCell />;
          return (
            <code
              className="block truncate font-mono text-xs"
              title={value.group.groupIdentifier}
              data-testid={E2eTestId.TeamSyncGroupRow}
            >
              {value.group.groupIdentifier}
            </code>
          );
        },
      },
      {
        id: "role",
        header: "Team role",
        size: 136,
        cell: ({ row }) => {
          const value = row.original;
          if (value.kind === "add") return null;
          if (value.kind === "draft") return <DraftRoleCell />;
          return value.group.role === MEMBER_ROLE_NAME ? "Member" : "Admin";
        },
      },
      ...(readOnly
        ? []
        : [
            {
              id: "actions",
              header: "Actions",
              size: 96,
              cell: ({ row }) => {
                const value = row.original;
                if (value.kind === "add") return null;
                if (value.kind === "draft") return <DraftActionsCell />;
                return (
                  <TableRowActions
                    itemName={value.group.groupIdentifier}
                    actions={[
                      {
                        icon: <Trash2 className="h-4 w-4" />,
                        label: "Unlink group",
                        variant: "destructive",
                        disabled: latest.current.busy,
                        onClick: () => latest.current.unlink(value.group.id),
                      },
                    ]}
                  />
                );
              },
            } satisfies ColumnDef<Row>,
          ]),
    ],
    [readOnly, groups.length],
  );

  const rows: Row[] = [
    ...groups.map((group) => ({ kind: "group" as const, id: group.id, group })),
    ...(canLink
      ? [
          draft.active
            ? { kind: "draft" as const, id: "__draft__" }
            : { kind: "add" as const, id: "__add__" },
        ]
      : []),
  ];

  return (
    <DraftContext.Provider value={draft}>
      <div className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">Team Sync</h3>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Add people to {team.name} from their identity provider groups. Each
            sign-in gives them the group&apos;s team role and removes them once
            they leave the group.{" "}
            {readOnly && <span>Team admins manage these links. </span>}
            <ExternalDocsLink
              href={getDocsUrl(DocsPage.PlatformSsoTeamSync, "team-sync")}
            >
              Learn more
            </ExternalDocsLink>
          </p>
        </div>

        {providers.length === 0 && !readOnly && (
          <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
            {canCreateIdentityProviders ? (
              <>
                <Link
                  href="/settings/identity-providers"
                  className="underline underline-offset-4 hover:text-foreground"
                >
                  Add an identity provider
                </Link>{" "}
                before linking groups.
              </>
            ) : (
              <span>
                Ask your admin to add an identity provider before linking
                groups.
              </span>
            )}
          </p>
        )}

        {(rows.length > 0 || isLoading) && (
          <DataTable
            columns={columns}
            data={rows}
            getRowId={(row) => row.id}
            isLoading={isLoading}
            getRowClassName={(row) =>
              row.kind === "add"
                ? "relative text-muted-foreground hover:bg-muted/40 has-[button:focus-visible]:bg-muted/40"
                : row.kind === "draft"
                  ? "bg-muted/30 hover:bg-muted/30"
                  : undefined
            }
            emptyMessage="No groups linked yet"
            fixedWidthColumnIds={["provider", "role", "actions"]}
            flexibleColumnIds={["identifier"]}
          />
        )}
        {draft.active && (
          <p className="text-xs text-muted-foreground">
            Press Enter to link, Esc to cancel.
          </p>
        )}
      </div>
    </DraftContext.Provider>
  );
}

// ===

type Team = archestraApiTypes.GetTeamResponses["200"];
type GroupLink =
  archestraApiTypes.GetTeamExternalGroupsResponses["200"][number];
type Provider =
  archestraApiTypes.GetIdentityProviderTeamSyncOptionsResponses["200"][number];
type TeamRole = GroupLink["role"];
type LinkBody = NonNullable<archestraApiTypes.AddTeamExternalGroupData["body"]>;
type Row =
  | { kind: "group"; id: string; group: GroupLink }
  | { kind: "draft"; id: string }
  | { kind: "add"; id: string };

type Draft = ReturnType<typeof useDraftState>;
const DraftContext = createContext<Draft | null>(null);

function useDraft() {
  const draft = useContext(DraftContext);
  if (!draft) throw new Error("useDraft must be used inside TeamSyncSection");
  return draft;
}

function useDraftState(params: {
  providers: Provider[];
  groups: GroupLink[];
  busy: boolean;
  onLink: (link: LinkBody) => void;
}) {
  const [active, setActive] = useState(false);
  const [providerId, setProviderId] = useState("");
  const [identifier, setIdentifier] = useState("");
  const [role, setRole] = useState<TeamRole>(MEMBER_ROLE_NAME);
  const effectiveProviderId = params.providers.some((p) => p.id === providerId)
    ? providerId
    : (params.providers[0]?.id ?? "");
  const value = identifier.trim();
  const duplicate = params.groups.some(
    (group) =>
      group.identityProviderId === effectiveProviderId &&
      group.groupIdentifier === value.toLowerCase(),
  );
  const canSubmit = !!value && !!effectiveProviderId && !duplicate;

  return {
    active,
    providers: params.providers,
    providerId: effectiveProviderId,
    identifier,
    role,
    duplicate,
    canSubmit: canSubmit && !params.busy,
    setProviderId,
    setIdentifier,
    setRole,
    open: () => {
      setIdentifier("");
      setRole(MEMBER_ROLE_NAME);
      setActive(true);
    },
    close: () => {
      setIdentifier("");
      setActive(false);
    },
    submit: () => {
      if (!canSubmit || params.busy) return;
      params.onLink({
        identityProviderId: effectiveProviderId,
        groupIdentifier: value,
        role,
      });
    },
  };
}

function providerLabel(providers: Provider[], id: string | null) {
  if (!id) return "Any provider";
  return providers.find((provider) => provider.id === id)?.providerId ?? id;
}

/**
 * Lives in the first cell but stretches over the whole row (the row is
 * `relative`), so the full width is one click target with one focus ring.
 */
function AddGroupRowButton({ empty }: { empty: boolean }) {
  const draft = useDraft();
  return (
    <>
      <span aria-hidden className="block h-8" />
      <UnstyledButton
        onClick={draft.open}
        className="absolute inset-0 flex w-full cursor-pointer items-center gap-2 rounded-b-md px-4 text-left text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <Plus className="size-4 shrink-0" />
        <span>Link a group</span>
        {empty && (
          <span className="ml-auto truncate text-xs">No groups linked yet</span>
        )}
      </UnstyledButton>
    </>
  );
}

/** Plain text when only one provider is configured; a select otherwise. */
function DraftProviderCell() {
  const draft = useDraft();
  if (draft.providers.length <= 1) {
    return (
      <span className="block truncate">{draft.providers[0]?.providerId}</span>
    );
  }
  return (
    <Select value={draft.providerId} onValueChange={draft.setProviderId}>
      <SelectTrigger
        size="sm"
        aria-label="Identity provider"
        className="w-full"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {draft.providers.map((provider) => (
          <SelectItem key={provider.id} value={provider.id}>
            {provider.providerId}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function DraftIdentifierCell() {
  const draft = useDraft();
  const inputRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef(draft.close);
  closeRef.current = draft.close;
  // The dialog listens for Escape in the document capture phase, before this
  // input's own handler, so Escape would close the whole dialog. Claim it first.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.target !== inputRef.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closeRef.current();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
  return (
    <Input
      ref={inputRef}
      autoFocus
      aria-label="Group identifier"
      aria-invalid={draft.duplicate || undefined}
      title={draft.duplicate ? "This group is already linked" : undefined}
      placeholder="Exact group ID or name"
      value={draft.identifier}
      onChange={(event) => draft.setIdentifier(event.target.value)}
      onKeyDown={(event) => {
        // Enter would submit the dialog's form.
        if (event.key === "Enter") {
          event.preventDefault();
          draft.submit();
        }
      }}
      className="h-8 font-mono text-xs"
    />
  );
}

function DraftRoleCell() {
  const draft = useDraft();
  return (
    <TeamMemberRoleSelect
      size="sm"
      className="w-full"
      value={draft.role}
      onChange={draft.setRole}
      ariaLabel="Team role for the linked group"
    />
  );
}

function DraftActionsCell() {
  const draft = useDraft();
  return (
    <TableRowActions
      actions={[
        {
          icon: <Check className="h-4 w-4" />,
          label: "Link group",
          disabled: !draft.canSubmit,
          disabledTooltip: draft.duplicate
            ? "This group is already linked"
            : "Enter a group identifier",
          onClick: draft.submit,
        },
        {
          icon: <X className="h-4 w-4" />,
          label: "Cancel",
          onClick: draft.close,
        },
      ]}
    />
  );
}

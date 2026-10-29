"use client";

import {
  ADMIN_ROLE_NAME,
  archestraApiSdk,
  type archestraApiTypes,
  DocsPage,
  getDocsUrl,
  MEMBER_ROLE_NAME,
} from "@archestra/shared";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { ArrowRight, Search, Trash2, UserPlus, Users } from "lucide-react";
import Link from "next/link";
import {
  type ComponentType,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { AdvancedLabelsSection } from "@/components/advanced-labels-section";
import { AdvancedSection } from "@/components/advanced-section";
import type { ProfileLabel, ProfileLabelsRef } from "@/components/agent-labels";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { RoleAssignmentBlockedNotice } from "@/components/role-assignment-blocked-notice";
import { TabbedDialogShell } from "@/components/tabbed-dialog-shell";
import { TableRowActions } from "@/components/table-row-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { FieldDescription } from "@/components/ui/field-description";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RoleSelect } from "@/components/ui/role-select";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TablePagination } from "@/components/ui/table-pagination";
import { Textarea } from "@/components/ui/textarea";
import {
  UserSearchableMultiSelect,
  type UserSelectOption,
} from "@/components/user-searchable-multi-select";
import { useHasPermissions } from "@/lib/auth/auth.query";
import config from "@/lib/config/config";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { useMemberSearch } from "@/lib/member.query";
import {
  parseRoleAssignmentBlocked,
  RoleAssignmentBlockedError,
} from "@/lib/role-assignment-blocked";
import { useTeams } from "@/lib/teams/team.query";
import {
  formatTeamPath,
  getTeamDescendantIds,
} from "@/lib/teams/team-hierarchy";
import { throwOnApiError } from "@/lib/utils/api";
import { formatRoleName } from "@/lib/utils/role";
import { cn } from "@/lib/utils/tailwind";
import { EnterpriseLicenseRequired } from "../enterprise-license-required";
import { TeamMemberRoleSelect } from "./team-member-role-select";

type Team = archestraApiTypes.GetTeamResponses["200"];
type TeamListItem = archestraApiTypes.GetTeamsResponses["200"]["data"][number];
type TeamDialogSection = "team" | "members" | "team-sync";
type TeamMemberRole = typeof ADMIN_ROLE_NAME | typeof MEMBER_ROLE_NAME;

const MEMBERS_PAGE_SIZE = 20;

/**
 * Member edits staged in the dialog, keyed by userId. Nothing is sent to the
 * server until Save — the members list renders the server state with these
 * changes applied on top.
 */
type StagedMemberChange =
  | { type: "add"; role: TeamMemberRole; name?: string; email?: string }
  // `role` is set when the removed member is an admin, for the admin count.
  | { type: "remove"; role?: TeamMemberRole }
  | { type: "role"; role: TeamMemberRole };
type StagedMemberChanges = Map<string, StagedMemberChange>;
type TeamSyncSectionComponent = ComponentType<{
  open: boolean;
  team: Team;
  readOnly?: boolean;
}>;

type TeamManagementDialogProps =
  | {
      mode: "create";
      open: boolean;
      onOpenChange: (open: boolean) => void;
    }
  | {
      mode?: "edit";
      open: boolean;
      onOpenChange: (open: boolean) => void;
      team: Team;
      /**
       * View-only access for callers who can read identity-provider
       * configuration but not manage the team: only the Team Sync section is
       * shown, without its mutation controls.
       */
      readOnly?: boolean;
    };

const editNavItems = [
  { id: "team", label: "Team" },
  { id: "members", label: "Members" },
  { id: "team-sync", label: "Team Sync" },
] satisfies Array<{ id: TeamDialogSection; label: string }>;

const createNavItems = [{ id: "team", label: "Team" }] satisfies Array<{
  id: TeamDialogSection;
  label: string;
}>;

export function TeamManagementDialog(props: TeamManagementDialogProps) {
  const { open, onOpenChange } = props;
  const mode = props.mode ?? "edit";
  const [createdTeam, setCreatedTeam] = useState<Team | null>(null);
  const editTeam = "team" in props ? props.team : null;
  const readOnly = "readOnly" in props && props.readOnly;
  const team = editTeam ?? createdTeam;
  const queryClient = useQueryClient();
  const [activeSection, setActiveSection] = useState<TeamDialogSection>("team");
  const [name, setName] = useState(team?.name ?? "");
  const [roles, setRoles] = useState((team?.roles ?? []).join(","));
  const [description, setDescription] = useState(team?.description ?? "");
  const [parentId, setParentId] = useState<string | null>(
    team?.parentId ?? null,
  );
  const [labels, setLabels] = useState<ProfileLabel[]>(team?.labels ?? []);
  // A refused role, parent team, or member add, shown under the section.
  const [assignmentBlocked, setAssignmentBlocked] =
    useState<RoleAssignmentBlockedError | null>(null);
  const [memberChanges, setMemberChanges] = useState<StagedMemberChanges>(
    new Map(),
  );
  const labelsRef = useRef<ProfileLabelsRef>(null);
  const TeamSyncSection = useTeamSyncSection();

  const { data: canUpdateTeams = false } = useHasPermissions({
    team: ["update"],
  });
  const { data: organizationTeams = [] } = useTeams({
    includeRelations: false,
    enabled: open && (mode === "create" || canUpdateTeams),
  });

  const syncAvailable = config.enterpriseFeatures.core;
  const navItems = useMemo(() => {
    const syncItem = {
      ...editNavItems[2],
      disabled: !syncAvailable,
      status: !syncAvailable ? "Enterprise license required" : undefined,
    };
    const items = [editNavItems[0], editNavItems[1], syncItem];
    if (mode === "create") {
      return team ? [editNavItems[0], editNavItems[1]] : createNavItems;
    }

    if (readOnly) {
      return [syncItem];
    }

    if (!canUpdateTeams) {
      return items;
    }

    return items;
  }, [canUpdateTeams, mode, readOnly, team, syncAvailable]);
  const title =
    mode === "create" && !team
      ? "Create Team"
      : readOnly
        ? "Team Sync"
        : "Edit Team";
  const canEditDetails = mode === "create" || canUpdateTeams;

  useEffect(() => {
    if (!open) return;
    setActiveSection(readOnly ? "team-sync" : "team");
    setMemberChanges(new Map());
    setAssignmentBlocked(null);
    if (mode === "create") {
      setCreatedTeam(null);
      setName("");
      setDescription("");
      setRoles("");
      setParentId(null);
      setLabels([]);
      return;
    }

    setName(editTeam?.name ?? "");
    setDescription(editTeam?.description ?? "");
    setRoles((editTeam?.roles ?? []).join(","));
    setParentId(editTeam?.parentId ?? null);
    setLabels(editTeam?.labels ?? []);
  }, [editTeam, mode, open, readOnly]);

  useEffect(() => {
    const canShowActiveSection =
      (activeSection === "team" && !readOnly) ||
      (activeSection === "members" && !!team && !readOnly) ||
      (activeSection === "team-sync" && syncAvailable);

    if (!canShowActiveSection) {
      setActiveSection(readOnly ? "team-sync" : "team");
    }
  }, [activeSection, readOnly, team, syncAvailable]);

  const saveTeam = useMutation({
    mutationFn: async () => {
      let savedTeam = team;
      // Team details are only editable with org-level team management; a
      // team admin can still open the dialog to manage members, so skip the
      // details update they aren't allowed to make.
      if (canEditDetails && activeSection === "team") {
        // Flush any label typed into the picker but not yet committed.
        const finalLabels = labelsRef.current?.saveUnsavedLabel() ?? labels;
        const body = {
          name: name.trim(),
          description: description.trim() || undefined,
          roles: roles.split(",").filter(Boolean),
          parentId,
          labels: finalLabels.map(({ key, value }) => ({ key, value })),
        };
        const { data, error } = !team
          ? await archestraApiSdk.createTeam({ body })
          : await archestraApiSdk.updateTeam({
              path: { id: team.id },
              body,
            });
        if (error)
          throw (
            parseRoleAssignmentBlocked(error) ?? new Error(error.error.message)
          );
        savedTeam = data as Team;
      }

      // Apply staged member changes (members can only be staged once the
      // team exists). Failed changes stay staged so Save can be retried.
      const failedChanges: StagedMemberChanges = new Map();
      const memberErrors: string[] = [];
      let memberBlocked: RoleAssignmentBlockedError | null = null;
      if (savedTeam) {
        for (const [userId, change] of memberChanges) {
          try {
            if (change.type === "add") {
              const { error } = await archestraApiSdk.addTeamMember({
                path: { id: savedTeam.id },
                body: { userId, role: change.role },
              });
              if (error)
                throw (
                  parseRoleAssignmentBlocked(error) ??
                  new Error(error.error.message)
                );
            } else if (change.type === "remove") {
              const { error } = await archestraApiSdk.removeTeamMember({
                path: { id: savedTeam.id, userId },
              });
              if (error) throw new Error(error.error.message);
            } else {
              const { error } = await archestraApiSdk.updateTeamMember({
                path: { id: savedTeam.id, userId },
                body: { role: change.role },
              });
              if (error) throw new Error(error.error.message);
            }
          } catch (err) {
            failedChanges.set(userId, change);
            // Every refused add names the same team items: one notice
            // explains them all.
            if (err instanceof RoleAssignmentBlockedError)
              memberBlocked ??= err;
            else
              memberErrors.push(err instanceof Error ? err.message : `${err}`);
          }
        }
      }

      return {
        savedTeam,
        failedChanges,
        memberErrors,
        memberBlocked,
        hadMemberChanges: memberChanges.size > 0,
      };
    },
    onMutate: () => setAssignmentBlocked(null),
    onSuccess: ({
      savedTeam,
      failedChanges,
      memberErrors,
      memberBlocked,
      hadMemberChanges,
    }) => {
      queryClient.invalidateQueries({ queryKey: ["auth"] });
      queryClient.invalidateQueries({ queryKey: ["teams"] });
      if (hadMemberChanges && savedTeam) {
        queryClient.invalidateQueries({
          queryKey: ["teamMembers", savedTeam.id],
        });
        queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
        queryClient.invalidateQueries({ queryKey: ["tools"] });
      }
      setMemberChanges(failedChanges);
      if (mode === "create" && !team && savedTeam) {
        setCreatedTeam(savedTeam);
      }
      if (memberBlocked) {
        setAssignmentBlocked(memberBlocked);
        return;
      }
      if (memberErrors.length > 0) {
        toast.error(
          `Failed to apply ${memberErrors.length} member change${
            memberErrors.length === 1 ? "" : "s"
          }: ${memberErrors[0]}`,
        );
        // Keep the dialog open so the remaining staged changes can be retried.
        return;
      }
      if (mode === "create" && !team) {
        toast.success("Team created");
        return;
      }
      toast.success("Team updated");
      onOpenChange(false);
    },
    onError: (error: Error) => {
      if (error instanceof RoleAssignmentBlockedError) {
        setAssignmentBlocked(error);
        return;
      }
      toast.error(
        error.message ||
          (mode === "create"
            ? "Failed to create team"
            : "Failed to update team"),
      );
    },
  });

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (canEditDetails && !name.trim()) {
      toast.error("Team name is required");
      return;
    }
    saveTeam.mutate();
  };

  return (
    <TabbedDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description="Manage team details, members, and Team Sync."
      sidebarLabel={name.trim() || (mode === "create" ? "New team" : "Team")}
      sidebarDescription="Team"
      sidebarIcon={<Users className="h-4 w-4 text-muted-foreground" />}
      activeSection={activeSection}
      navItems={navItems}
      onActiveSectionChange={setActiveSection}
      onSubmit={handleSubmit}
      className="max-w-5xl"
      contentClassName="px-5 py-5"
      sidebarClassName="w-[220px]"
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          {(activeSection === "team" && canEditDetails) ||
          (activeSection === "members" && memberChanges.size > 0) ? (
            <Button type="submit" disabled={saveTeam.isPending}>
              {saveTeam.isPending
                ? mode === "create" && !team
                  ? "Creating..."
                  : "Saving..."
                : mode === "create" && !team
                  ? "Create Team"
                  : "Save Changes"}
            </Button>
          ) : (
            <Button type="button" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          )}
        </>
      }
    >
      {activeSection === "team" && (
        <TeamSection
          team={team}
          name={name}
          description={description}
          roles={roles}
          onRolesChange={(value) => {
            setRoles(value);
            setAssignmentBlocked(null);
          }}
          parentId={parentId}
          organizationTeams={organizationTeams}
          canManageAllTeams={canUpdateTeams}
          labels={labels}
          labelsRef={labelsRef}
          onNameChange={setName}
          onDescriptionChange={setDescription}
          onParentIdChange={(value) => {
            setParentId(value);
            setAssignmentBlocked(null);
          }}
          onLabelsChange={setLabels}
          readOnlyDetails={!canEditDetails}
        />
      )}
      {activeSection === "members" && team && (
        <MembersSection
          open={open}
          team={team}
          changes={memberChanges}
          onChangesChange={(changes) => {
            setMemberChanges(changes);
            setAssignmentBlocked(null);
          }}
          onGoToTeamSync={
            syncAvailable ? () => setActiveSection("team-sync") : undefined
          }
        />
      )}
      {(activeSection === "team" || activeSection === "members") && (
        <RoleAssignmentBlockedNotice
          error={assignmentBlocked}
          name={{
            role: formatRoleName(roles),
            team:
              activeSection === "members"
                ? team?.name
                : organizationTeams.find(
                    (candidate) => candidate.id === parentId,
                  )?.name,
          }}
        />
      )}

      {activeSection === "team-sync" &&
        syncAvailable &&
        mode === "edit" &&
        team && <TeamSyncSection open={open} team={team} readOnly={readOnly} />}
    </TabbedDialogShell>
  );
}

function TeamSection(props: {
  team: Team | null;
  name: string;
  description: string;
  roles: string;
  onRolesChange: (roles: string) => void;
  parentId: string | null;
  organizationTeams: TeamListItem[];
  canManageAllTeams: boolean;
  labels: ProfileLabel[];
  labelsRef: React.Ref<ProfileLabelsRef>;
  onNameChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onParentIdChange: (value: string | null) => void;
  onLabelsChange: (labels: ProfileLabel[]) => void;
  readOnlyDetails: boolean;
}) {
  const descendantIds = new Set(
    props.team
      ? getTeamDescendantIds(props.organizationTeams, props.team.id)
      : [],
  );
  const parentOptions = props.organizationTeams.filter(
    (candidate) =>
      candidate.id !== props.team?.id &&
      !descendantIds.has(candidate.id) &&
      (props.canManageAllTeams || candidate.myRole === ADMIN_ROLE_NAME),
  );

  return (
    <div className="space-y-6">
      <div className="grid max-w-3xl gap-4">
        <div className="space-y-2">
          <Label htmlFor="team-name">Team Name *</Label>
          <Input
            id="team-name"
            value={props.name}
            onChange={(event) => props.onNameChange(event.target.value)}
            disabled={props.readOnlyDetails}
            maxLength={256}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="team-description">Description</Label>
          <Textarea
            id="team-description"
            value={props.description}
            onChange={(event) => props.onDescriptionChange(event.target.value)}
            disabled={props.readOnlyDetails}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="team-roles">Inherited Roles</Label>
          <FieldDescription id="team-roles-description">
            Members of this team and its descendant teams inherit these
            permissions. Alternatively, assign roles directly to{" "}
            <Link
              href="/settings/users"
              className="underline underline-offset-4"
            >
              users
            </Link>
            .
          </FieldDescription>
          <RoleSelect
            multiple
            allowEmpty
            id="team-roles"
            ariaLabel="Inherited Roles"
            aria-describedby="team-roles-description"
            value={props.roles}
            onValueChange={props.onRolesChange}
            disabled={props.readOnlyDetails}
          />
        </div>
        <AdvancedSection keepMounted>
          <div className="space-y-2">
            <Label htmlFor="team-parent">Parent Team</Label>
            <FieldDescription id="team-parent-description">
              Nest this team in your organization hierarchy. Resource access is
              inherited through the hierarchy; team administration is not.{" "}
              <ExternalDocsLink
                href={getDocsUrl(
                  DocsPage.PlatformAccessControl,
                  "team-hierarchies",
                )}
              >
                Learn about inherited access
              </ExternalDocsLink>
              .
            </FieldDescription>
            <SearchableSelect
              id="team-parent"
              ariaLabel="Parent Team"
              aria-describedby="team-parent-description"
              value={props.parentId ?? "root"}
              onValueChange={(value) =>
                props.onParentIdChange(value === "root" ? null : value)
              }
              disabled={props.readOnlyDetails}
              className="w-full"
              placeholder="No parent team"
              searchPlaceholder="Search teams..."
              emptyMessage="No matching teams found."
              pinnedItems={[{ value: "root", label: "No parent team" }]}
              items={parentOptions.map((candidate) => ({
                value: candidate.id,
                label: formatTeamPath(props.organizationTeams, candidate.id),
                description: candidate.description ?? undefined,
              }))}
            />
          </div>
          {props.readOnlyDetails ? (
            <ReadOnlyLabels labels={props.labels} />
          ) : (
            <AdvancedLabelsSection
              attributionSource="billingTeam"
              ref={props.labelsRef}
              labels={props.labels}
              onLabelsChange={props.onLabelsChange}
            />
          )}
        </AdvancedSection>
      </div>
    </div>
  );
}

function ReadOnlyLabels({ labels }: { labels: ProfileLabel[] }) {
  return (
    <div className="space-y-2">
      <Label>Labels</Label>
      <div className="flex flex-wrap gap-2">
        {labels.length === 0 ? (
          <span className="text-sm text-muted-foreground">No labels</span>
        ) : (
          labels.map((label) => (
            <Badge
              key={label.key}
              variant="secondary"
              className="flex items-center gap-1"
            >
              <span className="font-semibold">{label.key}:</span>
              <span>{label.value}</span>
            </Badge>
          ))
        )}
      </div>
    </div>
  );
}

function MembersSection({
  open,
  team,
  changes,
  onChangesChange,
  onGoToTeamSync,
}: {
  open: boolean;
  team: Team;
  changes: StagedMemberChanges;
  onChangesChange: (changes: StagedMemberChanges) => void;
  onGoToTeamSync?: () => void;
}) {
  const {
    users: userOptions,
    onSearchQueryChange: setCandidateSearch,
    emptyMessage: candidatesEmptyMessage,
  } = useMemberSearch({ limit: 20, enabled: open });
  const [adding, setAdding] = useState(false);

  // A team can have thousands of members, so they are searched and paged on
  // the server; staged changes are kept per user across pages.
  const [memberSearch, setMemberListSearch] = useState("");
  const debouncedMemberSearch = useDebouncedValue(memberSearch.trim(), 300);
  const [pageIndex, setPageIndex] = useState(0);
  const {
    data: memberPage,
    isPending: isMemberPagePending,
    isPlaceholderData: isMemberPageStale,
  } = useQuery({
    queryKey: [
      "teamMembers",
      team.id,
      "page",
      { search: debouncedMemberSearch, pageIndex },
    ],
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getTeamMembersPage({
        path: { id: team.id },
        query: {
          limit: MEMBERS_PAGE_SIZE,
          offset: pageIndex * MEMBERS_PAGE_SIZE,
          ...(debouncedMemberSearch ? { search: debouncedMemberSearch } : {}),
        },
      });
      throwOnApiError(error, { toastOnError: false });
      // Tagged with its search so the summary describes the rows on screen
      // while a newer search is still loading.
      return data ? { ...data, search: debouncedMemberSearch } : null;
    },
    enabled: open,
    placeholderData: keepPreviousData,
  });
  const pageMembers = memberPage?.data ?? [];
  const pageTotal = memberPage?.pagination.total ?? 0;

  // Team-wide totals for the summary line, independent of the search.
  const { data: savedTotals } = useQuery({
    queryKey: ["teamMembers", team.id, "totals"],
    queryFn: async () => {
      const [all, admins] = await Promise.all([
        archestraApiSdk.getTeamMembersPage({
          path: { id: team.id },
          query: { limit: 1 },
        }),
        archestraApiSdk.getTeamMembersPage({
          path: { id: team.id },
          query: { limit: 1, role: ADMIN_ROLE_NAME },
        }),
      ]);
      throwOnApiError(all.error, { toastOnError: false });
      throwOnApiError(admins.error, { toastOnError: false });
      return {
        members: all.data?.pagination.total ?? 0,
        admins: admins.data?.pagination.total ?? 0,
      };
    },
    enabled: open,
  });

  // Which of the users offered for adding are already members, wherever they
  // sit in the paged list.
  const optionUserIds = useMemo(
    () => userOptions.map((option) => option.userId).sort(),
    [userOptions],
  );
  const { data: membersAmongOptions = [] } = useQuery({
    queryKey: ["teamMembers", team.id, "among", optionUserIds],
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getTeamMembersPage({
        path: { id: team.id },
        query: { userIds: optionUserIds, limit: optionUserIds.length },
      });
      throwOnApiError(error, { toastOnError: false });
      return data?.data ?? [];
    },
    enabled: open && optionUserIds.length > 0,
    placeholderData: keepPreviousData,
  });

  // Users picked in the add strip may scroll out of the current search
  // results before they are added; keep their names for the staged rows.
  const seenUsers = useRef(new Map<string, UserSelectOption>());
  for (const option of userOptions) {
    seenUsers.current.set(option.userId, option);
  }

  const setChange = (userId: string, change: StagedMemberChange | null) => {
    const next = new Map(changes);
    if (change) {
      next.set(userId, change);
    } else {
      next.delete(userId);
    }
    onChangesChange(next);
  };

  const stageAdds = (userIds: string[], role: TeamMemberRole) => {
    const next = new Map(changes);
    for (const userId of userIds) {
      if (next.get(userId)?.type === "remove") {
        // Re-adding an existing member just cancels a staged removal.
        next.delete(userId);
      } else if (
        !membersAmongOptions.some((member) => member.userId === userId)
      ) {
        const user = seenUsers.current.get(userId);
        next.set(userId, {
          type: "add",
          role,
          name: user?.name ?? undefined,
          email: user?.email ?? undefined,
        });
      }
    }
    onChangesChange(next);
    setCandidateSearch("");
  };

  const stageRemove = (userId: string, originalRole: string | null) => {
    if (changes.get(userId)?.type === "add") {
      setChange(userId, null);
    } else {
      setChange(userId, {
        type: "remove",
        role: originalRole === ADMIN_ROLE_NAME ? ADMIN_ROLE_NAME : undefined,
      });
    }
  };

  const stageRole = (params: {
    userId: string;
    role: TeamMemberRole;
    originalRole: string | null;
  }) => {
    const change = changes.get(params.userId);
    if (change?.type === "add") {
      setChange(params.userId, { ...change, role: params.role });
      return;
    }
    setChange(
      params.userId,
      params.originalRole === params.role
        ? null
        : { type: "role", role: params.role },
    );
  };

  const stagedAdds = [...changes.entries()].filter(
    (entry): entry is [string, Extract<StagedMemberChange, { type: "add" }>] =>
      entry[1].type === "add",
  );

  // Staged additions first, then this page of server members with staged
  // removals hidden and staged role changes applied.
  const memberRows: MemberRow[] = [
    ...stagedAdds.map(([userId, change]) => ({
      userId,
      displayName: change.name || change.email || userId,
      displayEmail: change.email || userId,
      role: change.role as string,
      originalRole: null,
      staged: "added" as const,
    })),
    ...pageMembers
      .filter((member) => changes.get(member.userId)?.type !== "remove")
      .map((member) => {
        const change = changes.get(member.userId);
        return {
          userId: member.userId,
          displayName: member.name || member.email || member.userId,
          displayEmail: member.email || member.userId,
          role: change?.type === "role" ? change.role : member.role,
          originalRole: member.role,
          staged: change?.type === "role" ? ("changed" as const) : null,
        };
      }),
  ];

  const disabledUserIds = new Set([
    ...stagedAdds.map(([userId]) => userId),
    ...membersAmongOptions
      .map((member) => member.userId)
      .filter((userId) => changes.get(userId)?.type !== "remove"),
  ]);

  // Saved totals with the staged changes applied.
  let memberCount = savedTotals?.members ?? 0;
  let adminCount = savedTotals?.admins ?? 0;
  for (const change of changes.values()) {
    if (change.type === "add") {
      memberCount += 1;
      if (change.role === ADMIN_ROLE_NAME) adminCount += 1;
    } else if (change.type === "remove") {
      memberCount -= 1;
      if (change.role === ADMIN_ROLE_NAME) adminCount -= 1;
    } else {
      adminCount += change.role === ADMIN_ROLE_NAME ? 1 : -1;
    }
  }
  const searchedFor = memberPage?.search ?? "";
  const showMemberSearch = memberSearch !== "" || pageTotal > MEMBERS_PAGE_SIZE;

  // Cells read the latest handlers through a ref so the columns, and the
  // controls inside them, stay mounted across renders.
  const handlers = useRef({ stageRole, stageRemove });
  handlers.current = { stageRole, stageRemove };
  const columns = useMemo<ColumnDef<MemberRow>[]>(
    () => [
      {
        id: "name",
        header: "Name",
        cell: ({ row }) => <MemberNameCell row={row.original} />,
      },
      {
        id: "role",
        header: "Team role",
        size: 136,
        cell: ({ row }) => (
          <TeamMemberRoleSelect
            size="sm"
            className="w-[7.5rem]"
            value={row.original.role as TeamMemberRole}
            ariaLabel={`Team role for ${row.original.displayName}`}
            onChange={(role) =>
              handlers.current.stageRole({
                userId: row.original.userId,
                role,
                originalRole: row.original.originalRole,
              })
            }
          />
        ),
      },
      {
        id: "actions",
        header: "Actions",
        size: 72,
        cell: ({ row }) => (
          <TableRowActions
            itemName={row.original.displayName}
            actions={[
              {
                label: "Remove from team",
                icon: <Trash2 className="h-4 w-4" />,
                variant: "destructive",
                onClick: () =>
                  handlers.current.stageRemove(
                    row.original.userId,
                    row.original.originalRole,
                  ),
              },
            ]}
          />
        ),
      },
    ],
    [],
  );

  const unsaved =
    changes.size > 0 ? (
      <UnsavedMemberChanges
        count={changes.size}
        onDiscard={() => onChangesChange(new Map())}
      />
    ) : null;

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-2">
          <p className="flex min-w-0 items-center gap-1.5 truncate text-sm text-muted-foreground">
            <MemberCount value={memberCount} noun="member" />
            <span aria-hidden>·</span>
            <MemberCount value={adminCount} noun="admin" />
            {onGoToTeamSync && (
              <>
                <span aria-hidden>·</span>
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto gap-1 p-0 text-sm text-muted-foreground hover:text-foreground"
                  onClick={onGoToTeamSync}
                >
                  <span>Synced groups</span>
                  <ArrowRight className="size-3.5" />
                </Button>
              </>
            )}
          </p>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {showMemberSearch && (
              <div className="relative w-52">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={memberSearch}
                  onChange={(event) => {
                    setMemberListSearch(event.target.value);
                    setPageIndex(0);
                  }}
                  onKeyDown={(event) => {
                    // Enter would submit the dialog's form.
                    if (event.key === "Enter") event.preventDefault();
                  }}
                  placeholder="Search members"
                  aria-label="Search members"
                  className="h-8 pl-8"
                />
              </div>
            )}
            <Button
              type="button"
              variant={adding ? "secondary" : "outline"}
              size="sm"
              aria-expanded={adding}
              onClick={() => setAdding((current) => !current)}
            >
              <UserPlus className="h-4 w-4" />
              <span>Add members</span>
            </Button>
          </div>
        </div>
        {adding && (
          <MemberAddStrip
            users={userOptions}
            disabledUserIds={disabledUserIds}
            onSearchQueryChange={setCandidateSearch}
            emptyMessage={candidatesEmptyMessage}
            onAdd={(userIds, role) => {
              stageAdds(userIds, role);
              setAdding(false);
            }}
            onCancel={() => setAdding(false)}
          />
        )}
      </div>

      <div className={cn(isMemberPageStale && "opacity-60 transition-opacity")}>
        <DataTable
          columns={columns}
          data={memberRows}
          getRowId={(row) => row.userId}
          manualPagination
          isLoading={isMemberPagePending}
          getRowClassName={(row) => (row.staged ? "bg-muted/30" : undefined)}
          fixedWidthColumnIds={["role", "actions"]}
          flexibleColumnIds={["name"]}
          emptyIcon={Users}
          emptyMessage="No members yet"
          emptyDescription="Add people to give them this team's resources."
          hasActiveFilters={searchedFor !== ""}
          filteredEmptyMessage="No members match your search"
          onClearFilters={() => {
            setMemberListSearch("");
            setPageIndex(0);
          }}
        />
      </div>

      {pageTotal > MEMBERS_PAGE_SIZE ? (
        <TablePagination
          compact
          pageIndex={pageIndex}
          pageSize={MEMBERS_PAGE_SIZE}
          total={pageTotal}
          onPaginationChange={({ pageIndex: next }) => setPageIndex(next)}
          leftContent={unsaved}
        />
      ) : (
        unsaved && <div className="flex h-8 items-center">{unsaved}</div>
      )}
    </div>
  );
}

type MemberRow = {
  userId: string;
  displayName: string;
  displayEmail: string;
  role: string;
  originalRole: string | null;
  staged: "added" | "changed" | null;
};

function MemberAddStrip({
  users,
  disabledUserIds,
  onSearchQueryChange,
  emptyMessage,
  onAdd,
  onCancel,
}: {
  users: UserSelectOption[];
  disabledUserIds: Set<string>;
  onSearchQueryChange: (value: string) => void;
  emptyMessage: string;
  onAdd: (userIds: string[], role: TeamMemberRole) => void;
  onCancel: () => void;
}) {
  const [userIds, setUserIds] = useState<string[]>([]);
  const [role, setRole] = useState<TeamMemberRole>(MEMBER_ROLE_NAME);

  return (
    <div className="flex items-center gap-2 rounded-md border bg-muted/30 p-2 animate-in fade-in-0 slide-in-from-top-1 duration-150">
      <UserSearchableMultiSelect
        value={userIds}
        onValueChange={setUserIds}
        users={users}
        disabledUserIds={disabledUserIds}
        onSearchQueryChange={onSearchQueryChange}
        emptyMessage={emptyMessage}
        placeholder="Choose people to add"
        searchPlaceholder="Search users by name or email"
        maxBadgeDisplay={2}
        className="min-w-0 flex-1"
      />
      <TeamMemberRoleSelect
        value={role}
        onChange={setRole}
        ariaLabel="Team role for new members"
        className="w-32 bg-background"
      />
      <Button
        type="button"
        disabled={userIds.length === 0}
        onClick={() => onAdd(userIds, role)}
      >
        {userIds.length > 1 ? `Add ${userIds.length}` : "Add"}
      </Button>
      <Button type="button" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

function MemberNameCell({ row }: { row: MemberRow }) {
  return (
    <div className="min-w-0 leading-tight">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="truncate text-sm font-medium">{row.displayName}</span>
        {row.staged && (
          <Badge
            variant="outline"
            className="border-primary/30 px-1.5 py-0 text-[11px] text-primary"
          >
            {row.staged === "added" ? "New" : "Changed"}
          </Badge>
        )}
      </div>
      <div className="truncate text-xs text-muted-foreground">
        {row.displayEmail}
      </div>
    </div>
  );
}

function MemberCount({ value, noun }: { value: number; noun: string }) {
  return (
    <span className="whitespace-nowrap">
      <span className="font-medium text-foreground tabular-nums">{value}</span>
      <span> {value === 1 ? noun : `${noun}s`}</span>
    </span>
  );
}

function UnsavedMemberChanges({
  count,
  onDiscard,
}: {
  count: number;
  onDiscard: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
      <span aria-hidden className="size-1.5 rounded-full bg-primary" />
      <span>
        {count} unsaved {count === 1 ? "change" : "changes"}
      </span>
      <span aria-hidden>·</span>
      <Button
        type="button"
        variant="link"
        size="sm"
        className="h-auto p-0 text-sm text-muted-foreground hover:text-foreground"
        onClick={onDiscard}
      >
        Discard
      </Button>
    </span>
  );
}

function TeamSyncSectionUnavailable() {
  return <EnterpriseLicenseRequired featureName="Team Sync" />;
}

function useTeamSyncSection(): TeamSyncSectionComponent {
  const [Section, setSection] = useState<TeamSyncSectionComponent>(
    () => TeamSyncSectionUnavailable,
  );

  useEffect(() => {
    if (!config.enterpriseFeatures.core) return;

    let cancelled = false;

    async function loadEnterpriseSection() {
      // biome-ignore lint/style/noRestrictedImports: conditional ee component with team sync
      const module = await import("./team-sync-section.ee");
      if (!cancelled) {
        setSection(() => module.TeamSyncSection);
      }
    }

    loadEnterpriseSection();

    return () => {
      cancelled = true;
    };
  }, []);

  return Section;
}

"use client";

import type {
  PermissionSubject,
  ResourceVisibilityScope,
} from "@archestra/shared";
import { Building2, Plus, Trash2, UserRound, UsersRound } from "lucide-react";
import { useState } from "react";
import { SubjectIcon, subjectLabels } from "@/components/resource-permissions";
import { SearchableMultiSelect } from "@/components/searchable-multi-select";
import { SettingsSection } from "@/components/settings-section";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { UserSearchableMultiSelect } from "@/components/user-searchable-multi-select";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useOrganizationMembers } from "@/lib/organization.query";
import { useTeams } from "@/lib/teams/team.query";
import { formatTeamPath } from "@/lib/teams/team-hierarchy";

type A2aAccessChoice = ResourceVisibilityScope | "user";

/**
 * The Permissions block of an external agent, drawn like every other
 * resource's: who has access as a list, changed through "Add access".
 *
 * External agents still use their own sharing model rather than grants: one
 * audience at a time (the owner alone, selected people, selected teams, or the
 * whole organization). The list shows that audience, and adding a different
 * kind of recipient replaces it, which the add dialog says before it happens.
 */
export function A2aRemoteAgentPermissions({
  scope,
  teamIds,
  userIds,
  ownerName,
  knownTeams = [],
  knownUsers = [],
  initialScope,
  readOnly = false,
  error,
  onChange,
}: {
  scope: ResourceVisibilityScope;
  teamIds: string[];
  userIds: string[];
  /** Omit while the agent is being created: the signed-in user will own it. */
  ownerName?: string | null;
  /** Names saved on the agent, for recipients the viewer cannot list. */
  knownTeams?: Array<{ id: string; name: string }>;
  knownUsers?: Array<{ id: string; name: string; email: string }>;
  initialScope?: ResourceVisibilityScope;
  readOnly?: boolean;
  error?: string;
  onChange?: (next: {
    choice: A2aAccessChoice;
    scope: ResourceVisibilityScope;
    teamIds: string[];
    userIds: string[];
  }) => void;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const { data: canReadTeams } = useHasPermissions({ team: ["read"] });
  const { data: canManageExternalAgents } = useHasPermissions({
    organizationSettings: ["update"],
  });
  const { data: isAdmin } = useHasPermissions({ agent: ["update"] }, "*");
  const canShareOrganization = !!canManageExternalAgents || !!isAdmin;
  const { data: teams = [] } = useTeams({ enabled: !!canReadTeams });
  const { data: members = [] } = useOrganizationMembers();
  const { data: session } = useSession();
  // Narrowing a shared agent back to its owner alone is not offered, the same
  // rule the audience picker has always enforced.
  const ownerOnlyLocked = !!initialScope && initialScope !== "personal";
  const choice: A2aAccessChoice =
    scope === "personal" && userIds.length > 0 ? "user" : scope;
  const owner =
    ownerName === undefined ? (session?.user.name ?? null) : ownerName;

  const rows: Array<{
    key: string;
    type: PermissionSubject["type"];
    name: string;
    onRemove: () => void;
    removeBlockedReason?: string;
  }> = [];
  const toOwnerOnly = () =>
    onChange?.({
      choice: "personal",
      scope: "personal",
      teamIds: [],
      userIds: [],
    });
  if (choice === "org") {
    rows.push({
      key: "organization",
      type: "organization",
      name: "Everyone in the organization",
      onRemove: toOwnerOnly,
      removeBlockedReason: ownerOnlyLocked
        ? "Use Add access to choose another audience"
        : undefined,
    });
  }
  if (choice === "team") {
    for (const id of teamIds) {
      const remaining = teamIds.filter((teamId) => teamId !== id);
      rows.push({
        key: `team:${id}`,
        type: "team",
        name:
          teams.find((team) => team.id === id)?.name ??
          knownTeams.find((team) => team.id === id)?.name ??
          "Unknown team",
        onRemove: () =>
          remaining.length === 0 && !ownerOnlyLocked
            ? toOwnerOnly()
            : onChange?.({
                choice: "team",
                scope: "team",
                teamIds: remaining,
                userIds: [],
              }),
      });
    }
  }
  if (choice === "user") {
    for (const id of userIds) {
      const member =
        members.find((entry) => entry.id === id) ??
        knownUsers.find((entry) => entry.id === id);
      const remaining = userIds.filter((userId) => userId !== id);
      rows.push({
        key: `user:${id}`,
        type: "user",
        name: member?.name || member?.email || "Unknown user",
        onRemove: () =>
          onChange?.({
            choice: remaining.length === 0 ? "personal" : "user",
            scope: "personal",
            teamIds: [],
            userIds: remaining,
          }),
      });
    }
  }

  const addAccessButton =
    readOnly || !onChange ? null : (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="shrink-0"
        onClick={() => setAddOpen(true)}
      >
        <Plus className="size-4" />
        <span>Add access</span>
      </Button>
    );

  return (
    <SettingsSection
      title="Permissions"
      description="Choose who can discover this external agent and assign it to their agents."
    >
      <div
        className="rounded-md border px-3"
        aria-invalid={!!error}
        aria-describedby={error ? "a2a-access-error" : undefined}
      >
        <div className="flex items-center justify-between gap-3 py-3">
          <span className="min-w-0 text-sm text-muted-foreground">
            {audienceSummary(choice, teamIds.length, userIds.length)}
          </span>
          {addAccessButton}
        </div>
        <div className="divide-y border-t">
          {owner && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
              <UserRound
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="min-w-40 flex-1 truncate">
                {owner}
                <span className="ml-2 text-xs text-muted-foreground">
                  Owner
                </span>
              </span>
              <span className="w-48 shrink-0 px-3 text-sm text-muted-foreground">
                Full access
              </span>
              <span className="size-8 shrink-0" />
            </div>
          )}
          {rows.map((row) => (
            <div
              key={row.key}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2"
            >
              <SubjectIcon type={row.type} />
              <div className="flex min-w-40 flex-1 flex-wrap items-baseline gap-x-2">
                <span className="break-words text-sm font-medium">
                  {row.name}
                </span>
                <span className="text-xs text-muted-foreground">
                  {subjectLabels[row.type]}
                </span>
              </div>
              <span className="w-48 shrink-0 px-3 text-sm text-muted-foreground">
                Can discover and assign
              </span>
              {readOnly || !onChange ? (
                <span className="size-8 shrink-0" />
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0 text-muted-foreground"
                  aria-label={`Remove access for ${row.name}`}
                  title={row.removeBlockedReason}
                  disabled={!!row.removeBlockedReason}
                  onClick={row.onRemove}
                >
                  <Trash2 className="size-4" />
                </Button>
              )}
            </div>
          ))}
        </div>
      </div>
      {error ? (
        <p
          id="a2a-access-error"
          role="alert"
          className="text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}
      {addOpen && onChange && (
        <AddA2aAccessDialog
          onOpenChange={setAddOpen}
          choice={choice}
          teamIds={teamIds}
          userIds={userIds}
          teams={teams.map((team) => ({
            value: team.id,
            label: team.name,
            description: formatTeamPath(teams, team.id),
          }))}
          people={members
            .filter((member) => member.id !== session?.user.id)
            .map((member) => ({
              userId: member.id,
              name: member.name,
              email: member.email,
            }))}
          canAddPeople={!ownerOnlyLocked}
          canAddTeams={canShareOrganization && !!canReadTeams}
          canAddOrganization={canShareOrganization}
          onAdd={(next) => {
            onChange(next);
            setAddOpen(false);
          }}
        />
      )}
    </SettingsSection>
  );
}

// ===

function AddA2aAccessDialog({
  onOpenChange,
  choice,
  teamIds,
  userIds,
  teams,
  people,
  canAddPeople,
  canAddTeams,
  canAddOrganization,
  onAdd,
}: {
  onOpenChange: (open: boolean) => void;
  choice: A2aAccessChoice;
  teamIds: string[];
  userIds: string[];
  teams: Array<{ value: string; label: string; description?: string }>;
  people: Array<{ userId: string; name: string; email: string }>;
  canAddPeople: boolean;
  canAddTeams: boolean;
  canAddOrganization: boolean;
  onAdd: (next: {
    choice: A2aAccessChoice;
    scope: ResourceVisibilityScope;
    teamIds: string[];
    userIds: string[];
  }) => void;
}) {
  const [category, setCategory] = useState<"user" | "team" | "org" | null>(
    null,
  );
  const [selected, setSelected] = useState<string[]>([]);
  const replaces =
    category !== null && choice !== category && choice !== "personal"
      ? audienceSummary(choice, teamIds.length, userIds.length)
      : null;
  const availablePeople = people.filter(
    (person) => !userIds.includes(person.userId),
  );
  const availableTeams = teams.filter((team) => !teamIds.includes(team.value));
  const unavailable = {
    user: !canAddPeople
      ? "Not available once the agent is shared more widely"
      : availablePeople.length === 0
        ? choice === "user"
          ? "All of them already have access"
          : "No other members yet"
        : null,
    team: !canAddTeams
      ? "Requires permission to share with teams"
      : availableTeams.length === 0
        ? choice === "team"
          ? "All of them already have access"
          : "No teams yet"
        : null,
    org: !canAddOrganization
      ? "Requires permission to share with the organization"
      : choice === "org"
        ? "Already has access"
        : null,
  };

  function add() {
    if (category === "org") {
      onAdd({ choice: "org", scope: "org", teamIds: [], userIds: [] });
    } else if (category === "team") {
      onAdd({
        choice: "team",
        scope: "team",
        teamIds: choice === "team" ? [...teamIds, ...selected] : selected,
        userIds: [],
      });
    } else if (category === "user") {
      onAdd({
        choice: "user",
        scope: "personal",
        teamIds: [],
        userIds: choice === "user" ? [...userIds, ...selected] : selected,
      });
    }
  }

  return (
    <StandardDialog
      open
      onOpenChange={onOpenChange}
      title="Add access"
      description="Choose who can discover this external agent and assign it to their agents."
      isDirty={selected.length > 0 || category === "org"}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            aria-label={
              category === null ? "Cancel" : "Back to recipient types"
            }
            onClick={() => {
              if (category === null) onOpenChange(false);
              else {
                setSelected([]);
                setCategory(null);
              }
            }}
          >
            <span>{category === null ? "Cancel" : "Back"}</span>
          </Button>
          {category !== null && (
            <Button
              type="button"
              disabled={category !== "org" && selected.length === 0}
              onClick={add}
            >
              <span>Add access</span>
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        {category === null ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              {(
                [
                  {
                    type: "user",
                    label: "People",
                    description: "Choose individual members",
                    icon: UserRound,
                  },
                  {
                    type: "team",
                    label: "Teams",
                    description: "Include current and future members",
                    icon: UsersRound,
                  },
                ] as const
              ).map(({ type, label, description, icon: Icon }) => (
                <Button
                  key={type}
                  type="button"
                  variant="outline"
                  className="h-auto flex-col gap-3 whitespace-normal p-5 text-center"
                  disabled={!!unavailable[type]}
                  onClick={() => setCategory(type)}
                >
                  <Icon className="size-6 text-muted-foreground" />
                  <span className="space-y-1">
                    <span className="block font-medium">{label}</span>
                    <span className="block text-xs font-normal text-muted-foreground">
                      {unavailable[type] ?? description}
                    </span>
                  </span>
                </Button>
              ))}
            </div>
            <Button
              type="button"
              variant="ghost"
              className="h-auto w-full justify-start gap-3 whitespace-normal px-3 py-3"
              disabled={!!unavailable.org}
              title={unavailable.org ?? undefined}
              onClick={() => setCategory("org")}
            >
              <Building2 className="size-5 text-muted-foreground" />
              <span>Everyone in the organization</span>
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <h3 className="text-sm font-medium">
              {category === "user"
                ? "People"
                : category === "team"
                  ? "Teams"
                  : "Everyone in the organization"}
            </h3>
            {category === "user" && (
              <UserSearchableMultiSelect
                value={selected}
                onValueChange={setSelected}
                users={availablePeople}
                placeholder="Select people"
                searchPlaceholder="Search people..."
              />
            )}
            {category === "team" && (
              <SearchableMultiSelect
                ariaLabel="Teams"
                value={selected}
                onValueChange={setSelected}
                items={availableTeams}
                placeholder="Select teams"
                searchPlaceholder="Search teams..."
              />
            )}
            {category === "org" && (
              <p className="text-sm text-muted-foreground">
                Every member of the organization can discover this external
                agent and assign it to their agents.
              </p>
            )}
            {replaces && (
              <InlineNotice>
                <span className="font-medium">
                  This replaces the current access.
                </span>
                <InlineNoticeText>
                  An external agent is shared with one audience at a time.
                  Adding{" "}
                  {category === "org"
                    ? "the organization"
                    : `these ${category === "team" ? "teams" : "people"}`}{" "}
                  removes access for {replaces.toLowerCase()}.
                </InlineNoticeText>
              </InlineNotice>
            )}
          </div>
        )}
      </div>
    </StandardDialog>
  );
}

function audienceSummary(
  choice: A2aAccessChoice,
  teamCount: number,
  userCount: number,
): string {
  if (choice === "org") return "Everyone in the organization";
  if (choice === "team")
    return teamCount === 1 ? "1 team" : `${teamCount} teams`;
  if (choice === "user")
    return userCount === 1 ? "1 person" : `${userCount} people`;
  return "Only the owner";
}

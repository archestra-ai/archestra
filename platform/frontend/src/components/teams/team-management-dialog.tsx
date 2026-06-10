"use client";

import {
  ADMIN_ROLE_NAME,
  archestraApiSdk,
  type archestraApiTypes,
  MEMBER_ROLE_NAME,
} from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDebounce } from "@uidotdev/usehooks";
import { Check, Copy, Key, RefreshCw, Trash2, Users } from "lucide-react";
import { type ComponentType, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { TabbedDialogShell } from "@/components/tabbed-dialog-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { UserSearchableSelect } from "@/components/user-searchable-select";
import { useHasPermissions } from "@/lib/auth/auth.query";
import config from "@/lib/config/config";
import { useFeature } from "@/lib/config/config.query";
import { useMembersPaginated } from "@/lib/member.query";
import { useActiveOrganization } from "@/lib/organization.query";
import { type TeamToken, useTokens } from "@/lib/teams/team-token.query";
import { cn } from "@/lib/utils";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { EnterpriseLicenseRequired } from "../enterprise-license-required";

type Team = archestraApiTypes.GetTeamsResponses["200"]["data"][number];
type TeamMember = archestraApiTypes.GetTeamMembersResponses["200"][number];
type TeamDialogSection = "team" | "token" | "vault-folder" | "external-groups";
type TeamMemberRole = typeof ADMIN_ROLE_NAME | typeof MEMBER_ROLE_NAME;
type TeamManagementExternalSyncSectionComponent = ComponentType<{
  open: boolean;
  team: Team;
}>;
type TeamManagementVaultFolderSectionComponent = ComponentType<{
  open: boolean;
  team: Team;
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
    };

const editNavItems = [
  { id: "team", label: "Team" },
  { id: "external-groups", label: "External Group Sync" },
] satisfies Array<{ id: TeamDialogSection; label: string }>;

const tokenNavItem = {
  id: "token",
  label: "MCP/A2A Gateway Token",
} satisfies { id: TeamDialogSection; label: string };

const vaultFolderNavItem = {
  id: "vault-folder",
  label: "Vault Folder",
} satisfies { id: TeamDialogSection; label: string };

const createNavItems = [{ id: "team", label: "Team" }] satisfies Array<{
  id: TeamDialogSection;
  label: string;
}>;

export function TeamManagementDialog(props: TeamManagementDialogProps) {
  const { open, onOpenChange } = props;
  const mode = props.mode ?? "edit";
  const [createdTeam, setCreatedTeam] = useState<Team | null>(null);
  const editTeam = "team" in props ? props.team : null;
  const team = editTeam ?? createdTeam;
  const queryClient = useQueryClient();
  const [activeSection, setActiveSection] = useState<TeamDialogSection>("team");
  const [name, setName] = useState(team?.name ?? "");
  const [description, setDescription] = useState(team?.description ?? "");
  const TeamManagementExternalSyncSection =
    useTeamManagementExternalSyncSection();
  const TeamManagementVaultFolderSection =
    useTeamManagementVaultFolderSection();
  const { data: canUpdateTeams = false } = useHasPermissions({
    team: ["update"],
  });
  const { data: tokensData } = useTokens({
    enabled: open && mode === "edit" && canUpdateTeams,
  });
  const byosEnabled = useFeature("byosEnabled");
  const teamToken = tokensData?.tokens.find(
    (token) => token.team?.id === team?.id,
  );
  const navItems = useMemo(() => {
    if (mode === "create") {
      return createNavItems;
    }

    if (!canUpdateTeams) {
      return editNavItems;
    }

    if (!byosEnabled) {
      return [editNavItems[0], tokenNavItem, editNavItems[1]];
    }

    return [editNavItems[0], tokenNavItem, vaultFolderNavItem, editNavItems[1]];
  }, [byosEnabled, canUpdateTeams, mode]);
  const title = mode === "create" ? "Create Team" : "Edit Team";
  const canEditDetails = mode === "create" || canUpdateTeams;

  useEffect(() => {
    if (!open) return;
    setActiveSection("team");
    if (mode === "create") {
      setCreatedTeam(null);
      setName("");
      setDescription("");
      return;
    }

    setName(editTeam?.name ?? "");
    setDescription(editTeam?.description ?? "");
  }, [editTeam, mode, open]);

  useEffect(() => {
    const canShowActiveSection =
      activeSection === "team" ||
      activeSection === "external-groups" ||
      (activeSection === "token" && canUpdateTeams) ||
      (activeSection === "vault-folder" && canUpdateTeams && byosEnabled);

    if (!canShowActiveSection) {
      setActiveSection("team");
    }
  }, [activeSection, byosEnabled, canUpdateTeams]);

  const saveTeam = useMutation({
    mutationFn: async () => {
      const body = {
        name: name.trim(),
        description: description.trim() || undefined,
      };
      const { data, error } = !team
        ? await archestraApiSdk.createTeam({ body })
        : await archestraApiSdk.updateTeam({
            path: { id: team.id },
            body,
          });
      if (error) throw new Error(error.error.message);
      return data;
    },
    onSuccess: (savedTeam) => {
      queryClient.invalidateQueries({ queryKey: ["teams"] });
      queryClient.invalidateQueries({ queryKey: ["tokens"] });
      if (mode === "create" && !team) {
        setCreatedTeam(savedTeam as Team);
        toast.success("Team created");
        return;
      }
      toast.success("Team updated");
      onOpenChange(false);
    },
    onError: (error: Error) => {
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
    if (!name.trim()) {
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
      description="Manage team details, members, token access, and external group sync."
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
          {activeSection === "team" && canEditDetails ? (
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
          open={open}
          team={team}
          showMembers={Boolean(team)}
          name={name}
          description={description}
          onNameChange={setName}
          onDescriptionChange={setDescription}
          readOnlyDetails={!canEditDetails}
        />
      )}
      {activeSection === "token" && mode === "edit" && (
        <TokenSection token={teamToken} />
      )}
      {activeSection === "vault-folder" && mode === "edit" && team && (
        <TeamManagementVaultFolderSection open={open} team={team} />
      )}
      {activeSection === "external-groups" && mode === "edit" && team && (
        <TeamManagementExternalSyncSection open={open} team={team} />
      )}
    </TabbedDialogShell>
  );
}

function TeamSection(props: {
  open: boolean;
  team: Team | null;
  showMembers: boolean;
  name: string;
  description: string;
  onNameChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  readOnlyDetails: boolean;
}) {
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
      </div>

      {props.showMembers && props.team && (
        <>
          <Separator />

          <div className="space-y-4">
            <h3 className="text-sm font-medium">Members</h3>
            <MembersSection open={props.open} team={props.team} />
          </div>
        </>
      )}
    </div>
  );
}

function MembersSection({ open, team }: { open: boolean; team: Team }) {
  const queryClient = useQueryClient();
  const { data: activeOrg } = useActiveOrganization();
  const [memberSearch, setMemberSearch] = useState("");
  const debouncedMemberSearch = useDebounce(memberSearch, 300);

  const { data: teamMembers = [] } = useQuery({
    queryKey: ["teamMembers", team.id],
    queryFn: async () => {
      const { data } = await archestraApiSdk.getTeamMembers({
        path: { id: team.id },
      });
      return data ?? [];
    },
    enabled: open,
  });

  const { data: membersResponse, isPending: isMembersPending } =
    useMembersPaginated({
      limit: 20,
      offset: 0,
      name: debouncedMemberSearch || undefined,
    });

  const orgMembers = activeOrg?.members ?? [];
  const memberUserIds = useMemo(
    () => new Set(teamMembers.map((member) => member.userId)),
    [teamMembers],
  );
  const userOptions = (membersResponse?.data ?? []).map((member) => ({
    userId: member.userId,
    name: member.name,
    email: member.email,
  }));
  const canAddAnyMember = userOptions.some(
    (user) => !memberUserIds.has(user.userId),
  );

  const invalidateMembers = () => {
    queryClient.invalidateQueries({ queryKey: ["teamMembers", team.id] });
    queryClient.invalidateQueries({ queryKey: ["teams"] });
    queryClient.invalidateQueries({ queryKey: ["tokens"] });
    queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
    queryClient.invalidateQueries({ queryKey: ["tools"] });
  };

  const addMutation = useMutation({
    mutationFn: async (userId: string) => {
      const { error } = await archestraApiSdk.addTeamMember({
        path: { id: team.id },
        body: { userId, role: MEMBER_ROLE_NAME },
      });
      if (error) throw new Error(error.error.message);
    },
    onSuccess: () => {
      invalidateMembers();
      setMemberSearch("");
      toast.success("Member added to team");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to add member");
    },
  });

  const updateRoleMutation = useMutation({
    mutationFn: async (params: { userId: string; role: TeamMemberRole }) => {
      const { error } = await archestraApiSdk.updateTeamMember({
        path: { id: team.id, userId: params.userId },
        body: { role: params.role },
      });
      if (error) throw new Error(error.error.message);
    },
    onSuccess: () => {
      invalidateMembers();
      toast.success("Member role updated");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to update member role");
    },
  });

  const removeMutation = useMutation({
    mutationFn: async (userId: string) => {
      const { error } = await archestraApiSdk.removeTeamMember({
        path: { id: team.id, userId },
      });
      if (error) throw new Error(error.error.message);
    },
    onSuccess: () => {
      invalidateMembers();
      toast.success("Member removed from team");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to remove member");
    },
  });

  return (
    <div className="space-y-6">
      <div className="space-y-2 max-w-3xl">
        <Label>Add User</Label>
        <UserSearchableSelect
          value=""
          onValueChange={(userId) => addMutation.mutate(userId)}
          users={userOptions}
          disabledUserIds={memberUserIds}
          placeholder={
            canAddAnyMember ? "Select a user" : "All listed users already added"
          }
          searchPlaceholder="Search users by name or email"
          className="w-full"
          onSearchQueryChange={setMemberSearch}
          emptyMessage="No matching users found."
          hint={
            canAddAnyMember || isMembersPending
              ? undefined
              : "All users in the current result set are already members of this team."
          }
        />
      </div>

      <div className="space-y-2">
        <Label>Current Members ({teamMembers.length})</Label>
        {teamMembers.length === 0 ? (
          <div className="rounded-lg border border-dashed p-4 text-center">
            <p className="text-sm text-muted-foreground">
              No members in this team yet
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {teamMembers.map((member: TeamMember) => {
              const orgMember = orgMembers.find(
                (orgMember) => orgMember.userId === member.userId,
              );
              const displayName =
                member.name ||
                orgMember?.user.name ||
                member.email ||
                orgMember?.user.email ||
                member.userId;
              const displayEmail =
                member.email || orgMember?.user.email || member.userId;
              return (
                <div
                  key={member.id}
                  className="grid grid-cols-[minmax(0,1fr)_180px_40px] items-center gap-3 rounded-lg border p-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {displayName}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {displayEmail}
                    </p>
                  </div>
                  <Select
                    value={member.role}
                    onValueChange={(role: TeamMemberRole) =>
                      updateRoleMutation.mutate({
                        userId: member.userId,
                        role,
                      })
                    }
                    disabled={updateRoleMutation.isPending}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ADMIN_ROLE_NAME}>Admin</SelectItem>
                      <SelectItem value={MEMBER_ROLE_NAME}>Member</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => removeMutation.mutate(member.userId)}
                    disabled={removeMutation.isPending}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                    <span className="sr-only">Remove member</span>
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function TokenSection({ token }: { token?: TeamToken }) {
  const queryClient = useQueryClient();
  const [showValue, setShowValue] = useState(false);
  const [displayedValue, setDisplayedValue] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);

  const fetchValue = useMutation({
    mutationFn: async () => {
      if (!token) return null;
      const { data, error } = await archestraApiSdk.getTokenValue({
        path: { tokenId: token.id },
      });
      if (error) throw new Error(error.error.message);
      return data?.value ?? null;
    },
    onSuccess: (value) => {
      if (!value) return;
      setDisplayedValue(value);
      setShowValue(true);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const rotate = useMutation({
    mutationFn: async () => {
      if (!token) return null;
      const { data, error } = await archestraApiSdk.rotateToken({
        path: { tokenId: token.id },
      });
      if (error) throw new Error(error.error.message);
      return data?.value ?? null;
    },
    onSuccess: async (value) => {
      if (!value) return;
      await navigator.clipboard.writeText(value);
      setDisplayedValue(value);
      setShowValue(true);
      setConfirmRotate(false);
      queryClient.invalidateQueries({ queryKey: ["tokens"] });
      toast.success("Token rotated and copied to clipboard");
    },
    onError: (error: Error) => toast.error(error.message),
  });

  if (!token) {
    return (
      <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
        No token found for this team.
      </div>
    );
  }

  const handleShowToken = () => {
    if (showValue) {
      setShowValue(false);
      return;
    }
    fetchValue.mutate();
  };

  const handleCopy = async () => {
    if (!displayedValue) return;
    await navigator.clipboard.writeText(displayedValue);
    setCopied(true);
    toast.success("Token copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="space-y-2">
        <Label>Token</Label>
        <div className="flex gap-2">
          <Input
            readOnly
            value={
              showValue && displayedValue
                ? displayedValue
                : `${displayedValue ? displayedValue.substring(0, 14) : token.tokenStart}...`
            }
            className="font-mono"
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={handleShowToken}
          >
            <Key className="h-4 w-4" />
            <span className="sr-only">
              {showValue ? "Hide token" : "Show token"}
            </span>
          </Button>
          {showValue && displayedValue && (
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={handleCopy}
            >
              {copied ? (
                <Check className="h-4 w-4 text-green-500" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
              <span className="sr-only">Copy token</span>
            </Button>
          )}
        </div>
      </div>
      <div className="space-y-1 text-sm text-muted-foreground">
        <p>
          <strong>Created:</strong> {formatRelativeTimeFromNow(token.createdAt)}
        </p>
        <p>
          <strong>Last used:</strong>{" "}
          {formatRelativeTimeFromNow(token.lastUsedAt)}
        </p>
      </div>
      <Button
        type="button"
        variant={confirmRotate ? "destructive" : "outline"}
        onClick={() => {
          if (!confirmRotate) {
            setConfirmRotate(true);
            return;
          }
          rotate.mutate();
        }}
        disabled={rotate.isPending}
      >
        <RefreshCw
          className={cn("h-4 w-4", rotate.isPending && "animate-spin")}
        />
        {confirmRotate ? "Confirm Rotate" : "Rotate Token"}
      </Button>
    </div>
  );
}

function TeamManagementExternalSyncSectionUnavailable() {
  return <EnterpriseLicenseRequired featureName="Team Sync" />;
}

function TeamManagementVaultFolderSectionUnavailable() {
  return <EnterpriseLicenseRequired featureName="Team Vault Folders" />;
}

function useTeamManagementExternalSyncSection(): TeamManagementExternalSyncSectionComponent {
  const [Section, setSection] =
    useState<TeamManagementExternalSyncSectionComponent>(
      () => TeamManagementExternalSyncSectionUnavailable,
    );

  useEffect(() => {
    if (!config.enterpriseFeatures.core) return;

    let cancelled = false;

    async function loadEnterpriseSection() {
      // biome-ignore lint/style/noRestrictedImports: conditional ee component with team sync
      const module = await import("./team-management-external-sync.ee");
      if (!cancelled) {
        setSection(() => module.TeamManagementExternalSyncSection);
      }
    }

    loadEnterpriseSection();

    return () => {
      cancelled = true;
    };
  }, []);

  return Section;
}

function useTeamManagementVaultFolderSection(): TeamManagementVaultFolderSectionComponent {
  const [Section, setSection] =
    useState<TeamManagementVaultFolderSectionComponent>(
      () => TeamManagementVaultFolderSectionUnavailable,
    );

  useEffect(() => {
    if (!config.enterpriseFeatures.core) return;

    let cancelled = false;

    async function loadEnterpriseSection() {
      // biome-ignore lint/style/noRestrictedImports: conditional ee component with vault folder management
      const module = await import("./team-management-vault-folder.ee");
      if (!cancelled) {
        setSection(() => module.TeamManagementVaultFolderSection);
      }
    }

    loadEnterpriseSection();

    return () => {
      cancelled = true;
    };
  }, []);

  return Section;
}

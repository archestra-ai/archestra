"use client";

import {
  ADMIN_ROLE_NAME,
  archestraApiSdk,
  type archestraApiTypes,
  MEMBER_ROLE_NAME,
} from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDebounce } from "@uidotdev/usehooks";
import {
  Check,
  Copy,
  Key,
  RefreshCw,
  Trash2,
  Users,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogForm,
  DialogStickyFooter,
  DialogTitle,
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
import { Textarea } from "@/components/ui/textarea";
import { UserSearchableSelect } from "@/components/user-searchable-select";
import config from "@/lib/config/config";
import { useMembersPaginated } from "@/lib/member.query";
import { useActiveOrganization } from "@/lib/organization.query";
import { type TeamToken, useTokens } from "@/lib/teams/team-token.query";
import { cn } from "@/lib/utils";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { EnterpriseLicenseRequired } from "../enterprise-license-required";

type Team = archestraApiTypes.GetTeamsResponses["200"]["data"][number];
type TeamMember = archestraApiTypes.GetTeamMembersResponses["200"][number];
type TeamDialogSection = "team" | "token" | "external-groups";
type TeamMemberRole = typeof ADMIN_ROLE_NAME | typeof MEMBER_ROLE_NAME;

const { TeamManagementExternalSyncSection } = config.enterpriseFeatures.core
  ? // biome-ignore lint/style/noRestrictedImports: conditional ee component with team sync
    await import("./team-management-external-sync.ee")
  : {
      TeamManagementExternalSyncSection:
        TeamManagementExternalSyncSectionUnavailable,
    };

interface TeamManagementDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  team: Team;
}

const navItems = [
  { id: "team", label: "Team" },
  { id: "token", label: "MCP/A2A Gateway Token" },
  { id: "external-groups", label: "External Group Sync" },
] satisfies Array<{ id: TeamDialogSection; label: string }>;

export function TeamManagementDialog({
  open,
  onOpenChange,
  team,
}: TeamManagementDialogProps) {
  const queryClient = useQueryClient();
  const [activeSection, setActiveSection] = useState<TeamDialogSection>("team");
  const [name, setName] = useState(team.name);
  const [description, setDescription] = useState(team.description ?? "");
  const { data: tokensData } = useTokens({ enabled: open });
  const teamToken = tokensData?.tokens.find(
    (token) => token.team?.id === team.id,
  );

  useEffect(() => {
    if (!open) return;
    setActiveSection("team");
    setName(team.name);
    setDescription(team.description ?? "");
  }, [open, team]);

  const updateTeam = useMutation({
    mutationFn: async () => {
      const { data, error } = await archestraApiSdk.updateTeam({
        path: { id: team.id },
        body: {
          name: name.trim(),
          description: description.trim() || undefined,
        },
      });
      if (error) throw new Error(error.error.message);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["teams"] });
      toast.success("Team updated");
      onOpenChange(false);
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to update team");
    },
  });

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!name.trim()) {
      toast.error("Team name is required");
      return;
    }
    updateTeam.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-5xl h-[85vh] flex flex-row p-0 gap-0 overflow-hidden"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Edit Team</DialogTitle>
        <DialogDescription className="sr-only">
          Manage team details, members, token access, and external group sync.
        </DialogDescription>
        <DialogForm className="contents" onSubmit={handleSubmit}>
          <nav className="w-[220px] border-r flex flex-col shrink-0">
            <div className="flex min-h-[72px] items-center border-b px-4 py-4">
              <div className="flex min-w-0 items-center gap-2.5">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-muted">
                  <Users className="h-4 w-4 text-muted-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-sm truncate">
                    {team.name}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    Team
                  </div>
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-0.5 px-2 py-3 flex-1">
              {navItems.map((navItem) => (
                <Button
                  key={navItem.id}
                  type="button"
                  variant="ghost"
                  className={cn(
                    "justify-start h-9 px-3 font-normal w-full",
                    activeSection === navItem.id &&
                      "bg-accent text-accent-foreground font-medium",
                  )}
                  onClick={() => setActiveSection(navItem.id)}
                >
                  {navItem.label}
                </Button>
              ))}
            </div>
          </nav>

          <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
            <div className="flex min-h-[72px] shrink-0 items-center justify-between border-b px-4 py-4">
              <h2 className="text-lg font-semibold truncate">Edit Team</h2>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 rounded-xs opacity-70 hover:opacity-100"
                onClick={() => onOpenChange(false)}
              >
                <XIcon className="h-4 w-4" />
                <span className="sr-only">Close</span>
              </Button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-5 py-5">
              {activeSection === "team" && (
                <TeamSection
                  open={open}
                  team={team}
                  name={name}
                  description={description}
                  onNameChange={setName}
                  onDescriptionChange={setDescription}
                />
              )}
              {activeSection === "token" && <TokenSection token={teamToken} />}
              {activeSection === "external-groups" && (
                <TeamManagementExternalSyncSection open={open} team={team} />
              )}
            </div>

            <DialogStickyFooter className="mt-0">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              {activeSection === "team" ? (
                <Button type="submit" disabled={updateTeam.isPending}>
                  {updateTeam.isPending ? "Saving..." : "Save Changes"}
                </Button>
              ) : (
                <Button type="button" onClick={() => onOpenChange(false)}>
                  Close
                </Button>
              )}
            </DialogStickyFooter>
          </div>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}

function TeamSection(props: {
  open: boolean;
  team: Team;
  name: string;
  description: string;
  onNameChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
}) {
  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <div>
          <h3 className="text-sm font-semibold">Details</h3>
          <p className="text-sm text-muted-foreground">
            Update the team name and description shown across the workspace.
          </p>
        </div>
        <div className="space-y-4 max-w-3xl">
          <div className="space-y-2">
            <Label htmlFor="team-name">Team Name *</Label>
            <Input
              id="team-name"
              value={props.name}
              onChange={(event) => props.onNameChange(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="team-description">Description</Label>
            <Textarea
              id="team-description"
              value={props.description}
              onChange={(event) =>
                props.onDescriptionChange(event.target.value)
              }
            />
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <div>
          <h3 className="text-sm font-semibold">Members</h3>
          <p className="text-sm text-muted-foreground">
            Add users to this team and choose whether they are team admins or
            members.
          </p>
        </div>
        <MembersSection open={props.open} team={props.team} />
      </section>
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
              return (
                <div
                  key={member.id}
                  className="grid grid-cols-[minmax(0,1fr)_180px_40px] items-center gap-3 rounded-lg border p-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {member.email ||
                        orgMember?.user.email ||
                        member.name ||
                        member.userId}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {member.name || orgMember?.user.name || member.userId}
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

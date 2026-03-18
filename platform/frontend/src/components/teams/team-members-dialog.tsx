"use client";

import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDebounce } from "@uidotdev/usehooks";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { DialogStickyFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useMembersPaginated } from "@/lib/member.query";
import { useActiveOrganization } from "@/lib/organization.query";

interface Team {
  id: string;
  name: string;
  description: string | null;
}

interface TeamMembersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  team: Team;
}

type PaginatedMember =
  archestraApiTypes.GetMembersResponses["200"]["data"][number];
type TeamMember = archestraApiTypes.GetTeamMembersResponses["200"][number];
type ActiveOrganizationMember = {
  userId: string;
  name?: string | null;
  email?: string | null;
};

function getMemberDisplayName(
  member: Pick<
    PaginatedMember | TeamMember | ActiveOrganizationMember,
    "userId" | "name" | "email"
  >,
): string {
  return member.name || member.email || member.userId;
}

function getMemberEmail(
  member: Pick<
    PaginatedMember | TeamMember | ActiveOrganizationMember,
    "email"
  >,
): string | null {
  return member.email || null;
}

export function TeamMembersDialog({
  open,
  onOpenChange,
  team,
}: TeamMembersDialogProps) {
  const queryClient = useQueryClient();
  const { data: activeOrg } = useActiveOrganization();
  const [memberSearch, setMemberSearch] = useState("");
  const debouncedMemberSearch = useDebounce(memberSearch, 300);

  const { data: teamMembers } = useQuery({
    queryKey: ["teamMembers", team.id],
    queryFn: async () => {
      const { data } = await archestraApiSdk.getTeamMembers({
        path: { id: team.id },
      });
      return data;
    },
    enabled: open,
  });

  const { data: membersResponse, isPending: isMembersPending } =
    useMembersPaginated({
      limit: 20,
      offset: 0,
      name: debouncedMemberSearch || undefined,
    });

  const orgMembers = (activeOrg?.members ?? []) as ActiveOrganizationMember[];
  const memberUserIds = new Set(teamMembers?.map((m) => m.userId) || []);
  const memberOptions = (membersResponse?.data ?? []).map(
    (member: PaginatedMember) => {
      const isAlreadyAdded = memberUserIds.has(member.userId);

      return {
        value: member.userId,
        label: getMemberDisplayName(member),
        description: isAlreadyAdded
          ? `${getMemberEmail(member) || "No email"} • Already in team`
          : (getMemberEmail(member) ?? undefined),
        disabled: isAlreadyAdded,
        checked: isAlreadyAdded,
      };
    },
  );
  const canAddAnyMember = memberOptions.some((member) => !member.disabled);

  const addMutation = useMutation({
    mutationFn: async (userId: string) => {
      return await archestraApiSdk.addTeamMember({
        path: { id: team.id },
        body: {
          userId,
          role: "member",
        },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["teamMembers", team.id] });
      queryClient.invalidateQueries({ queryKey: ["teams"] });
      queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
      queryClient.invalidateQueries({ queryKey: ["tools"] });
      setMemberSearch("");
      toast.success("Member added to team successfully");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to add member");
    },
  });

  const removeMutation = useMutation({
    mutationFn: async (userId: string) => {
      return await archestraApiSdk.removeTeamMember({
        path: { id: team.id, userId },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["teamMembers", team.id] });
      queryClient.invalidateQueries({ queryKey: ["teams"] });
      queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
      queryClient.invalidateQueries({ queryKey: ["tools"] });
      toast.success("Member removed from team successfully");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to remove member");
    },
  });

  const handleAddMember = (userId: string) => {
    addMutation.mutate(userId);
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Manage Team Members"
      description={`Add or remove users from "${team.name}"`}
      size="medium"
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 space-y-4">
        <div className="space-y-2">
          <Label>Add User</Label>
          <SearchableSelect
            value=""
            onValueChange={handleAddMember}
            placeholder={
              canAddAnyMember
                ? "Select a user"
                : "All listed users already added"
            }
            searchPlaceholder="Search users by name or email"
            className="w-full"
            onSearchQueryChange={setMemberSearch}
            items={memberOptions}
            emptyMessage="No matching users found."
            hint={
              canAddAnyMember || isMembersPending
                ? undefined
                : "All users in the current result set are already members of this team."
            }
          />
        </div>

        <div className="space-y-2">
          <Label>Current Members ({teamMembers?.length || 0})</Label>
          {!teamMembers || teamMembers.length === 0 ? (
            <div className="rounded-lg border border-dashed p-4 text-center">
              <p className="text-sm text-muted-foreground">
                No members in this team yet
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {teamMembers.map((member) => {
                const orgMember = orgMembers.find(
                  (m: ActiveOrganizationMember) => m.userId === member.userId,
                );
                return (
                  <div
                    key={member.id}
                    className="flex items-center justify-between rounded-lg border p-3"
                  >
                    <div>
                      <p className="text-sm font-medium">
                        {member.email ||
                          orgMember?.email ||
                          getMemberDisplayName(member)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Role: {member.role}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => removeMutation.mutate(member.userId)}
                      disabled={removeMutation.isPending}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <DialogStickyFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          Close
        </Button>
      </DialogStickyFooter>
    </FormDialog>
  );
}

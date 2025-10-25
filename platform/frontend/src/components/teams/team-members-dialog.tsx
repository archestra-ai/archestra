"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  addTeamMember,
  getTeamMembers,
  removeTeamMember,
} from "@/lib/clients/api/sdk.gen";
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

export function TeamMembersDialog({
  open,
  onOpenChange,
  team,
}: TeamMembersDialogProps) {
  const queryClient = useQueryClient();
  const { data: activeOrg } = useActiveOrganization();
  const [selectedUserId, setSelectedUserId] = useState<string>("");

  const { data: teamMembers } = useQuery({
    queryKey: ["teamMembers", team.id],
    queryFn: async () => {
      const { data } = await getTeamMembers({
        path: { id: team.id },
      });
      return data;
    },
    enabled: open,
  });

  // Get organization members to show in dropdown
  const orgMembers = activeOrg?.members || [];
  const memberUserIds = new Set(teamMembers?.map((m) => m.userId) || []);
  const availableMembers = orgMembers.filter(
    (member) => !memberUserIds.has(member.userId),
  );

  const addMutation = useMutation({
    mutationFn: async (userId: string) => {
      return await addTeamMember({
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
      setSelectedUserId("");
      toast.success("Member added to team successfully");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to add member");
    },
  });

  const removeMutation = useMutation({
    mutationFn: async (userId: string) => {
      return await removeTeamMember({
        path: { id: team.id, userId },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["teamMembers", team.id] });
      queryClient.invalidateQueries({ queryKey: ["teams"] });
      toast.success("Member removed from team successfully");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to remove member");
    },
  });

  const handleAddMember = () => {
    if (selectedUserId) {
      addMutation.mutate(selectedUserId);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[550px]">
        <DialogHeader>
          <DialogTitle>Manage Team Members</DialogTitle>
          <DialogDescription>
            Add or remove members from "{team.name}"
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {availableMembers.length > 0 && (
            <div className="space-y-2">
              <Label>Add Member</Label>
              <div className="flex gap-2">
                <Select
                  value={selectedUserId}
                  onValueChange={setSelectedUserId}
                >
                  <SelectTrigger className="flex-1">
                    <SelectValue placeholder="Select a member" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableMembers.map((member) => (
                      <SelectItem key={member.id} value={member.userId}>
                        {member.user.email || member.userId}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  onClick={handleAddMember}
                  disabled={!selectedUserId || addMutation.isPending}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}

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
                    (m) => m.userId === member.userId,
                  );
                  return (
                    <div
                      key={member.id}
                      className="flex items-center justify-between rounded-lg border p-3"
                    >
                      <div>
                        <p className="text-sm font-medium">
                          {orgMember?.user.email || member.userId}
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

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

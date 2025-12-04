"use client";

import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Link2, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import config from "@/lib/config";
import { EnterpriseLicenseRequired } from "../enterprise-license-required";

interface Team {
  id: string;
  name: string;
  description: string | null;
}

interface TeamExternalGroupsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  team: Team;
}

type ExternalGroup =
  archestraApiTypes.GetTeamExternalGroupsResponses["200"][number];

export function TeamExternalGroupsDialog({
  open,
  onOpenChange,
  team,
}: TeamExternalGroupsDialogProps) {
  const queryClient = useQueryClient();
  const [newGroupIdentifier, setNewGroupIdentifier] = useState("");

  const { data: externalGroups, isLoading } = useQuery({
    queryKey: ["teamExternalGroups", team.id],
    queryFn: async () => {
      const { data } = await archestraApiSdk.getTeamExternalGroups({
        path: { id: team.id },
      });
      return data;
    },
    enabled: open && config.enterpriseLicenseActivated,
  });

  const addMutation = useMutation({
    mutationFn: async (groupIdentifier: string) => {
      return await archestraApiSdk.addTeamExternalGroup({
        path: { id: team.id },
        body: { groupIdentifier },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["teamExternalGroups", team.id],
      });
      setNewGroupIdentifier("");
      toast.success("External group mapping added");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to add external group mapping");
    },
  });

  const removeMutation = useMutation({
    mutationFn: async (groupId: string) => {
      return await archestraApiSdk.removeTeamExternalGroup({
        path: { id: team.id, groupId },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["teamExternalGroups", team.id],
      });
      toast.success("External group mapping removed");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to remove external group mapping");
    },
  });

  const handleAddGroup = () => {
    const trimmed = newGroupIdentifier.trim();
    if (!trimmed) {
      toast.error("Group identifier is required");
      return;
    }
    addMutation.mutate(trimmed);
  };

  if (!config.enterpriseLicenseActivated) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[550px]">
          <DialogHeader>
            <DialogTitle>External Group Sync</DialogTitle>
            <DialogDescription>
              Automatically sync team membership based on SSO groups
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <EnterpriseLicenseRequired featureName="Team Sync" />
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>External Group Sync</DialogTitle>
          <DialogDescription>
            Configure automatic team membership synchronization for "{team.name}
            " based on SSO groups. When users log in via SSO, they will be
            automatically added to or removed from this team based on their
            group memberships.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Add new group mapping */}
          <div className="space-y-2">
            <Label>Add External Group Mapping</Label>
            <div className="flex gap-2">
              <Input
                placeholder="e.g., archestra-admins, cn=engineering,ou=groups,dc=example,dc=com"
                value={newGroupIdentifier}
                onChange={(e) => setNewGroupIdentifier(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleAddGroup();
                  }
                }}
              />
              <Button
                onClick={handleAddGroup}
                disabled={addMutation.isPending || !newGroupIdentifier.trim()}
              >
                <Plus className="mr-2 h-4 w-4" />
                Add
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Enter the group identifier exactly as it appears in your identity
              provider. This is typically found in the "groups" claim of the SSO
              token.
            </p>
          </div>

          {/* Current mappings */}
          <div className="space-y-2">
            <Label>
              Linked External Groups ({externalGroups?.length || 0})
            </Label>
            {isLoading ? (
              <div className="py-4 text-center text-sm text-muted-foreground">
                Loading...
              </div>
            ) : !externalGroups || externalGroups.length === 0 ? (
              <div className="rounded-lg border border-dashed p-4 text-center">
                <Link2 className="mx-auto mb-2 h-8 w-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  No external groups linked yet. Add a group identifier above to
                  enable automatic team sync.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {externalGroups.map((group: ExternalGroup) => (
                  <div
                    key={group.id}
                    className="flex items-center justify-between rounded-lg border p-3"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-mono truncate">
                        {group.groupIdentifier}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Added {new Date(group.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => removeMutation.mutate(group.id)}
                      disabled={removeMutation.isPending}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* How it works */}
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>How Team Sync Works</AlertTitle>
            <AlertDescription className="space-y-2 text-sm">
              <p>
                When a user logs in via SSO, their group memberships are checked
                against the external groups linked to each team:
              </p>
              <ul className="list-disc list-inside space-y-1 text-muted-foreground">
                <li>
                  <strong>Added:</strong> Users in a linked group are
                  automatically added to the team
                </li>
                <li>
                  <strong>Removed:</strong> Users no longer in any linked group
                  are automatically removed (if they were added via sync)
                </li>
                <li>
                  <strong>Manual members preserved:</strong> Members added
                  manually are never removed by sync
                </li>
              </ul>
              <p className="text-muted-foreground">
                Group matching is case-insensitive.
              </p>
            </AlertDescription>
          </Alert>
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

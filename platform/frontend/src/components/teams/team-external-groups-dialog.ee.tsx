"use client";

import {
  archestraApiSdk,
  type archestraApiTypes,
  DocsPage,
  getDocsUrl,
} from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link2, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { DialogStickyFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import config from "@/lib/config/config";
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
    enabled: open && config.enterpriseFeatures.core,
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

  if (!config.enterpriseFeatures.core) {
    return (
      <FormDialog
        open={open}
        onOpenChange={onOpenChange}
        title="External Group Sync"
        description="Sync team membership from SSO groups."
        size="medium"
      >
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <EnterpriseLicenseRequired featureName="Team Sync" />
        </div>
        <DialogStickyFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogStickyFooter>
      </FormDialog>
    );
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="External Group Sync"
      description={
        <>
          Map SSO group identifiers to "{team.name}". Matching users are added
          to this team when they sign in.{" "}
          <ExternalDocsLink href={getDocsUrl(DocsPage.PlatformSsoTeamSync)}>
            Learn More
          </ExternalDocsLink>
        </>
      }
      size="medium"
      className="sm:max-w-[600px]"
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 space-y-6">
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
              <Plus className="h-4 w-4" />
              Add
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Use the exact group value emitted by your identity provider.
          </p>
        </div>

        {/* Current mappings */}
        <div className="space-y-2">
          <Label>Linked External Groups ({externalGroups?.length || 0})</Label>
          {isLoading ? (
            <div className="py-4 text-center text-sm text-muted-foreground">
              Loading...
            </div>
          ) : !externalGroups || externalGroups.length === 0 ? (
            <div className="rounded-lg border border-dashed p-4 text-center">
              <Link2 className="mx-auto mb-2 h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                No external groups linked yet.
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
      </div>

      <DialogStickyFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          Close
        </Button>
      </DialogStickyFooter>
    </FormDialog>
  );
}

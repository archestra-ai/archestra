"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { Globe, Lock, UserRound, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CopyableCode } from "@/components/copyable-code";
import { FormDialog } from "@/components/form-dialog";
import { AssignmentCombobox } from "@/components/ui/assignment-combobox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogStickyFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { UserSearchableMultiSelect } from "@/components/user-searchable-multi-select";
import {
  type VisibilityOption,
  VisibilitySelector,
} from "@/components/visibility-selector";
import { useSession } from "@/lib/auth/auth.query";
import {
  useConversationShare,
  useShareConversation,
  useUnshareConversation,
} from "@/lib/chat/chat-share.query";
import { useOrganizationMembers } from "@/lib/organization.query";
import { useTeams } from "@/lib/teams/team.query";

type ShareVisibility =
  | "private"
  | NonNullable<archestraApiTypes.ShareConversationData["body"]>["visibility"];

export function ShareConversationDialog({
  conversationId,
  open,
  onOpenChange,
}: {
  conversationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: share, isLoading } = useConversationShare(
    open ? conversationId : undefined,
  );
  const shareMutation = useShareConversation();
  const unshareMutation = useUnshareConversation();
  const { data: session } = useSession();
  const { data: teams = [] } = useTeams({ enabled: open });
  const { data: members = [] } = useOrganizationMembers(open);
  const currentUserId = session?.user?.id;
  const isShared = !!share;
  const isPending = shareMutation.isPending || unshareMutation.isPending;
  const [visibility, setVisibility] = useState<ShareVisibility>("private");
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [userIds, setUserIds] = useState<string[]>([]);
  const [hasSavedVisibleShare, setHasSavedVisibleShare] = useState(false);
  const hasVisibleShareLink =
    (isShared || hasSavedVisibleShare) && visibility !== "private";

  const shareLink = `${window.location.origin}/chat/${conversationId}`;

  const availableMembers = useMemo(
    () => members.filter((member) => member.id !== currentUserId),
    [currentUserId, members],
  );

  const teamItems = useMemo(
    () =>
      teams.map((team) => ({
        id: team.id,
        name: team.name,
      })),
    [teams],
  );

  const userOptions = useMemo(
    () =>
      availableMembers.map((member) => ({
        userId: member.id,
        name: member.name,
        email: member.email,
      })),
    [availableMembers],
  );

  const selectedTeamLabels = useMemo(
    () =>
      teamItems
        .filter((team) => teamIds.includes(team.id))
        .map((team) => team.name),
    [teamIds, teamItems],
  );

  useEffect(() => {
    if (!open) {
      return;
    }

    if (!share) {
      setVisibility("private");
      setTeamIds([]);
      setUserIds([]);
      setHasSavedVisibleShare(false);
      return;
    }

    setVisibility(share.visibility);
    setTeamIds(share.teamIds);
    setUserIds(share.userIds);
    setHasSavedVisibleShare(true);
  }, [open, share]);

  const visibilityOptions = useMemo<Array<VisibilityOption<ShareVisibility>>>(
    () => [
      {
        value: "private",
        label: "Private",
        description: "Only you have access to this chat.",
        icon: Lock,
      },
      {
        value: "organization",
        label: "Organization",
        description: "Anyone in your organization can view this chat.",
        icon: Globe,
      },
      {
        value: "team",
        label: "Teams",
        description: "Share this chat with selected teams.",
        icon: Users,
        disabled: teams.length === 0,
        disabledLabel: teams.length === 0 ? "No teams available" : undefined,
      },
      {
        value: "user",
        label: "Users",
        description: "Share this chat with selected people.",
        icon: UserRound,
        disabled: userOptions.length === 0,
        disabledLabel:
          userOptions.length === 0 ? "No users available" : undefined,
      },
    ],
    [teams.length, userOptions.length],
  );

  const handleSave = useCallback(async () => {
    if (isPending || isLoading) {
      return;
    }

    if (visibility === "private") {
      if (!isShared) {
        onOpenChange(false);
        return;
      }

      await unshareMutation.mutateAsync(conversationId);
      onOpenChange(false);
      return;
    }

    const nextTeamIds = visibility === "team" ? teamIds : [];
    const nextUserIds = visibility === "user" ? userIds : [];

    if (visibility === "team" && nextTeamIds.length === 0) {
      return;
    }

    if (visibility === "user" && nextUserIds.length === 0) {
      return;
    }

    const savedShare = await shareMutation.mutateAsync({
      conversationId,
      visibility,
      teamIds: nextTeamIds,
      userIds: nextUserIds,
      suppressSuccessToast: true,
    });

    if (!savedShare) {
      return;
    }

    setHasSavedVisibleShare(true);
    await navigator.clipboard.writeText(shareLink);
    toast.success("Chat visibility updated and share link copied");
  }, [
    conversationId,
    isLoading,
    isPending,
    isShared,
    onOpenChange,
    shareLink,
    shareMutation,
    teamIds,
    unshareMutation,
    userIds,
    visibility,
  ]);

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Chat Visibility"
      description="Choose whether this chat stays private or is shared with your organization, selected teams, or selected users."
      size="medium"
    >
      <DialogBody className="space-y-4">
        <VisibilitySelector
          value={visibility}
          options={visibilityOptions}
          onValueChange={setVisibility}
        >
          {visibility === "team" && (
            <div className="space-y-2">
              <Label>Teams</Label>
              <AssignmentCombobox
                items={teamItems}
                selectedIds={teamIds}
                onToggle={(teamId) =>
                  setTeamIds((current) =>
                    current.includes(teamId)
                      ? current.filter((id) => id !== teamId)
                      : [...current, teamId],
                  )
                }
                label="Select teams"
                placeholder="Search teams..."
                emptyMessage="No teams found."
                className="h-9 w-full justify-between border text-sm text-foreground"
              />
              {selectedTeamLabels.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {selectedTeamLabels.map((teamName) => (
                    <Badge key={teamName} variant="secondary">
                      {teamName}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          )}

          {visibility === "user" && (
            <div className="space-y-2">
              <Label>Users</Label>
              <UserSearchableMultiSelect
                value={userIds}
                onValueChange={setUserIds}
                users={userOptions}
                placeholder="Select users"
                searchPlaceholder="Search users..."
                emptyMessage="No users found."
                className="w-full"
              />
            </div>
          )}
        </VisibilitySelector>

        {hasVisibleShareLink && shareLink && (
          <CopyableCode
            value={shareLink}
            toastMessage="Share link copied"
            className="border bg-muted/50"
          />
        )}
      </DialogBody>
      <DialogStickyFooter className="mt-0">
        <Button
          variant="outline"
          className="w-full sm:w-auto"
          onClick={() => onOpenChange(false)}
          disabled={isPending}
        >
          Close
        </Button>
        <Button
          className="w-full sm:w-auto"
          onClick={handleSave}
          disabled={
            isPending ||
            (visibility === "team" && teamIds.length === 0) ||
            (visibility === "user" && userIds.length === 0)
          }
        >
          Save
        </Button>
      </DialogStickyFooter>
    </FormDialog>
  );
}

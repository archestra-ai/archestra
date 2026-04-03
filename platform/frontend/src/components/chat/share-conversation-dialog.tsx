"use client";

import type { archestraApiTypes } from "@shared";
import { Globe, Link, Lock, UserRound, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FormDialog } from "@/components/form-dialog";
import {
  AssignmentCombobox,
  type AssignmentComboboxItem,
} from "@/components/ui/assignment-combobox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogStickyFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
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
  const hasVisibleShareLink = !!share && visibility !== "private";

  const shareLink = share
    ? `${window.location.origin}/chat/${conversationId}`
    : "";

  const availableMembers = useMemo(
    () => members.filter((member) => member.id !== currentUserId),
    [currentUserId, members],
  );

  const teamItems = useMemo<AssignmentComboboxItem[]>(
    () =>
      teams.map((team) => ({
        id: team.id,
        name: team.name,
      })),
    [teams],
  );

  const userItems = useMemo<AssignmentComboboxItem[]>(
    () =>
      availableMembers.map((member) => ({
        id: member.id,
        name: member.name || member.email,
        description: member.email,
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

  const selectedUserLabels = useMemo(
    () =>
      userItems
        .filter((user) => userIds.includes(user.id))
        .map((user) => user.name),
    [userIds, userItems],
  );

  useEffect(() => {
    if (!open) {
      return;
    }

    if (!share) {
      setVisibility("private");
      setTeamIds([]);
      setUserIds([]);
      return;
    }

    setVisibility(share.visibility);
    setTeamIds(share.teamIds);
    setUserIds(share.userIds);
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
        disabled: userItems.length === 0,
        disabledLabel:
          userItems.length === 0 ? "No users available" : undefined,
      },
    ],
    [teams.length, userItems.length],
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

    await shareMutation.mutateAsync({
      conversationId,
      visibility,
      teamIds: nextTeamIds,
      userIds: nextUserIds,
    });
    onOpenChange(false);
  }, [
    conversationId,
    isLoading,
    isPending,
    isShared,
    onOpenChange,
    shareMutation,
    teamIds,
    unshareMutation,
    userIds,
    visibility,
  ]);

  const handleCopyLinkAndClose = useCallback(async () => {
    if (!shareLink) {
      return;
    }

    await navigator.clipboard.writeText(shareLink);
    onOpenChange(false);
  }, [onOpenChange, shareLink]);

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
              <AssignmentCombobox
                items={userItems}
                selectedIds={userIds}
                onToggle={(userId) =>
                  setUserIds((current) =>
                    current.includes(userId)
                      ? current.filter((id) => id !== userId)
                      : [...current, userId],
                  )
                }
                label="Select users"
                placeholder="Search users..."
                emptyMessage="No users found."
                className="h-9 w-full justify-between border text-sm text-foreground"
              />
              {selectedUserLabels.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {selectedUserLabels.map((userName) => (
                    <Badge key={userName} variant="secondary">
                      {userName}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          )}
        </VisibilitySelector>

        {hasVisibleShareLink && shareLink && (
          <div className="flex min-w-0 items-center gap-2 overflow-hidden rounded-md border bg-muted/50 px-3 py-2">
            <span className="min-w-0 flex-1 truncate font-mono text-sm text-muted-foreground">
              {shareLink}
            </span>
          </div>
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
        <Button
          variant="secondary"
          className="w-full sm:w-auto"
          onClick={handleCopyLinkAndClose}
          disabled={isPending || !hasVisibleShareLink || !shareLink}
        >
          <Link className="mr-2 h-4 w-4" />
          Copy Link
        </Button>
      </DialogStickyFooter>
    </FormDialog>
  );
}

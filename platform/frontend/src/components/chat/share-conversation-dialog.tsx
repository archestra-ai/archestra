"use client";

import { Globe, Link, Lock, UserRound, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FormDialog } from "@/components/form-dialog";
import { MultiSelectCombobox } from "@/components/ui/multi-select-combobox";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogStickyFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  VisibilitySelector,
  type VisibilityOption,
} from "@/components/visibility-selector";
import {
  useConversationShare,
  useShareConversation,
  useUnshareConversation,
} from "@/lib/chat/chat-share.query";
import { useOrganizationMembers } from "@/lib/organization.query";
import { useTeams } from "@/lib/teams/team.query";

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
  const { data: teams = [] } = useTeams({ enabled: open });
  const { data: members = [] } = useOrganizationMembers(open);
  const isShared = !!share;
  const isPending = shareMutation.isPending || unshareMutation.isPending;
  const [visibility, setVisibility] = useState<
    "private" | "organization" | "team" | "user"
  >("private");
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [userIds, setUserIds] = useState<string[]>([]);

  const shareLink = share
    ? `${window.location.origin}/chat/shared/${share.id}`
    : "";

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

  const visibilityOptions = useMemo<
    Array<VisibilityOption<"private" | "organization" | "team" | "user">>
  >(
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
        disabled: members.length === 0,
        disabledLabel: members.length === 0 ? "No users available" : undefined,
      },
    ],
    [members.length, teams.length],
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
    if (!shareLink) return;
    await navigator.clipboard.writeText(shareLink);
    onOpenChange(false);
  }, [shareLink, onOpenChange]);

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
              <MultiSelectCombobox
                options={teams.map((team) => ({
                  value: team.id,
                  label: team.name,
                }))}
                value={teamIds}
                onChange={setTeamIds}
                placeholder={
                  teams.length === 0 ? "No teams available" : "Search teams..."
                }
                emptyMessage="No teams found."
                disabled={isPending || isLoading}
              />
            </div>
          )}

          {visibility === "user" && (
            <div className="space-y-2">
              <Label>Users</Label>
              <MultiSelectCombobox
                options={members.map((member) => ({
                  value: member.id,
                  label: member.name || member.email,
                }))}
                value={userIds}
                onChange={setUserIds}
                placeholder={
                  members.length === 0 ? "No users available" : "Search users..."
                }
                emptyMessage="No users found."
                disabled={isPending || isLoading}
              />
            </div>
          )}
        </VisibilitySelector>

        {isShared && shareLink && (
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
          disabled={isPending || !shareLink}
        >
          <Link className="mr-2 h-4 w-4" />
          Copy Link
        </Button>
      </DialogStickyFooter>
    </FormDialog>
  );
}

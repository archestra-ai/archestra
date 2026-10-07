// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import { Info } from "lucide-react";
import { ShareLink } from "@/components/chat/share-link";
import { ResourcePermissionsDialog } from "@/components/resource-permissions";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";

export function ShareConversationDialog({
  conversationId,
  appIds = [],
  open,
  onOpenChange,
}: {
  conversationId: string;
  appIds?: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <ResourcePermissionsDialog
      resource="conversation"
      scope={conversationId}
      title="Chat permissions"
      description="Share a read-only view of this chat. Only its owner can continue the conversation."
      open={open}
      onOpenChange={onOpenChange}
      lead={
        <ShareLink
          path={`/chat/${conversationId}`}
          label="Chat link"
          toastMessage="Chat link copied"
        />
      }
    >
      {appIds.length > 0 && (
        <InlineNotice variant="info">
          <Info />
          <InlineNoticeText>
            Apps in this chat have their own permissions. Sharing the chat does
            not give access to those apps.
          </InlineNoticeText>
        </InlineNotice>
      )}
    </ResourcePermissionsDialog>
  );
}

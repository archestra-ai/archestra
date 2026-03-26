"use client";

import { Check, Link, Lock, Users } from "lucide-react";
import { useCallback } from "react";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogStickyFooter } from "@/components/ui/dialog";
import {
  useConversationShare,
  useShareConversation,
  useUnshareConversation,
} from "@/lib/chat/chat-share.query";
import { cn } from "@/lib/utils";

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
  const isShared = !!share;
  const isPending = shareMutation.isPending || unshareMutation.isPending;

  const shareLink = share
    ? `${window.location.origin}/chat/shared/${share.id}`
    : "";

  const handleSelectOrganization = useCallback(async () => {
    if (isShared || isPending) return;
    await shareMutation.mutateAsync(conversationId);
  }, [isShared, isPending, shareMutation, conversationId]);

  const handleSelectPrivate = useCallback(async () => {
    if (!isShared || isPending) return;
    await unshareMutation.mutateAsync(conversationId);
  }, [isShared, isPending, unshareMutation, conversationId]);

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
      description="Choose whether this chat stays private or is shared with your organization."
      size="medium"
    >
      <DialogBody className="space-y-3">
        <Button
          type="button"
          variant="outline"
          className={cn(
            "h-auto w-full justify-start rounded-lg px-4 py-5 text-left",
            !isShared
              ? "border-primary bg-primary/5 hover:bg-primary/10"
              : "hover:border-muted-foreground/50",
          )}
          onClick={handleSelectPrivate}
          disabled={isPending || isLoading}
        >
          <Lock className="mr-3 h-5 w-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="font-medium text-sm">Private</div>
            <div className="text-xs text-muted-foreground">
              Only you have access to this chat.
            </div>
          </div>
          {!isShared && <Check className="h-4 w-4 shrink-0 text-primary" />}
        </Button>

        <Button
          type="button"
          variant="outline"
          className={cn(
            "h-auto w-full justify-start rounded-lg px-4 py-5 text-left",
            isShared
              ? "border-primary bg-primary/5 hover:bg-primary/10"
              : "hover:border-muted-foreground/50",
          )}
          onClick={handleSelectOrganization}
          disabled={isPending || isLoading}
        >
          <Users className="mr-3 h-5 w-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="font-medium text-sm">
              Shared with Your Organization
            </div>
            <div className="text-xs text-muted-foreground">
              Anyone in your organization can view this chat.
            </div>
          </div>
          {isShared && <Check className="h-4 w-4 shrink-0 text-primary" />}
        </Button>

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
          className="w-full sm:w-auto"
          onClick={
            isShared && shareLink
              ? handleCopyLinkAndClose
              : () => onOpenChange(false)
          }
          disabled={isPending}
        >
          {isShared && shareLink ? (
            <>
              <Link className="mr-2 h-4 w-4" />
              Copy Link and Close
            </>
          ) : (
            "Close"
          )}
        </Button>
      </DialogStickyFooter>
    </FormDialog>
  );
}

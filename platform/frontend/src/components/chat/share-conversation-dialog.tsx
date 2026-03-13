"use client";

import { Check, Link, Lock, Users } from "lucide-react";
import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  useConversationShare,
  useShareConversation,
  useUnshareConversation,
} from "@/lib/chat-share.query";
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Chat Visibility</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3 pt-2 overflow-hidden">
          {/* Private option */}
          <button
            type="button"
            className={cn(
              "flex items-center gap-3 p-3 rounded-lg border transition-colors text-left",
              !isShared
                ? "border-primary bg-primary/5"
                : "border-border hover:border-muted-foreground/50",
            )}
            onClick={handleSelectPrivate}
            disabled={isPending || isLoading}
          >
            <Lock className="h-5 w-5 shrink-0 text-muted-foreground" />
            <div className="flex-1 min-w-0">
              <div className="font-medium text-sm">Private</div>
              <div className="text-xs text-muted-foreground">
                Only you have access to this chat.
              </div>
            </div>
            {!isShared && <Check className="h-4 w-4 text-primary shrink-0" />}
          </button>

          {/* Organization option */}
          <button
            type="button"
            className={cn(
              "flex items-center gap-3 p-3 rounded-lg border transition-colors text-left",
              isShared
                ? "border-primary bg-primary/5"
                : "border-border hover:border-muted-foreground/50",
            )}
            onClick={handleSelectOrganization}
            disabled={isPending || isLoading}
          >
            <Users className="h-5 w-5 shrink-0 text-muted-foreground" />
            <div className="flex-1 min-w-0">
              <div className="font-medium text-sm">
                Shared with Your Organization
              </div>
              <div className="text-xs text-muted-foreground">
                Anyone in your organization can view this chat.
              </div>
            </div>
            {isShared && <Check className="h-4 w-4 text-primary shrink-0" />}
          </button>

          {/* Share link */}
          {isShared && shareLink && (
            <div className="flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2 min-w-0 overflow-hidden">
              <span className="text-sm font-mono min-w-0 flex-1 truncate text-muted-foreground">
                {shareLink}
              </span>
            </div>
          )}

          {/* Action button */}
          <Button
            className="w-full"
            onClick={
              isShared && shareLink
                ? handleCopyLinkAndClose
                : () => onOpenChange(false)
            }
            disabled={isPending}
          >
            {isShared && shareLink ? (
              <>
                <Link className="h-4 w-4 mr-2" />
                Copy Link and Close
              </>
            ) : (
              "Close"
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

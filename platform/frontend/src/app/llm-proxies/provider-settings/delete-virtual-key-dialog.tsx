"use client";

import type { archestraApiTypes } from "@shared";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useDeleteVirtualApiKey } from "@/lib/chat-settings.query";

type VirtualKeyWithParent =
  archestraApiTypes.GetAllVirtualApiKeysResponses["200"]["data"][number];

interface DeleteVirtualKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  virtualKey: VirtualKeyWithParent | null;
}

export function DeleteVirtualKeyDialog({
  open,
  onOpenChange,
  virtualKey,
}: DeleteVirtualKeyDialogProps) {
  const deleteMutation = useDeleteVirtualApiKey();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete Virtual Key</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete &quot;{virtualKey?.name}&quot;? This
            action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              if (virtualKey) {
                deleteMutation.mutate(
                  {
                    chatApiKeyId: virtualKey.chatApiKeyId,
                    id: virtualKey.id,
                  },
                  {
                    onSuccess: () => {
                      onOpenChange(false);
                    },
                  },
                );
              }
            }}
            disabled={deleteMutation.isPending}
          >
            {deleteMutation.isPending && (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            )}
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

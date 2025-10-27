"use client";

import { Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface OAuthConfirmationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverName: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function OAuthConfirmationDialog({
  open,
  onOpenChange,
  serverName,
  onConfirm,
  onCancel,
}: OAuthConfirmationDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-blue-500" />
            MCP authentication magic happening!
          </DialogTitle>
          <DialogDescription className="pt-4 space-y-3 text-sm">
            You'll be redirected to {serverName}'s authorization page to grant
            access. After authentication, you'll be brought back here and the
            server will be installed with your credentials.
            <br />
            <br />
            <strong>Your tokens will be stored securely</strong> and only used
            to communicate with {serverName} on your behalf.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-3 sm:gap-3">
          <Button
            variant="outline"
            onClick={() => {
              onCancel();
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
            className="bg-blue-600 hover:bg-blue-700"
          >
            Continue to Authorization...
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

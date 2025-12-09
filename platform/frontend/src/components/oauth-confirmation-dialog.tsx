"use client";

import { ShieldCheck, User } from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
  const handleConfirm = () => {
    onConfirm();
    onOpenChange(false);
  };

  const handleCancel = () => {
    onCancel();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <User className="h-5 w-5" />
              <span>OAuth Authorization</span>
              <Badge
                variant="secondary"
                className="flex items-center gap-1 ml-2"
              >
                <ShieldCheck className="h-3 w-3" />
                OAuth
              </Badge>
              <span className="text-muted-foreground ml-2 font-normal">
                {serverName}
              </span>
            </div>
          </DialogTitle>
          <DialogDescription className="pt-4 space-y-3 text-sm">
            You'll be redirected to {serverName}'s authorization page to grant
            access. After authentication, you'll be brought back here and the
            server will be installed with your credentials.
          </DialogDescription>
        </DialogHeader>

        <DialogFooter className="gap-3 sm:gap-3">
          <Button variant="outline" onClick={handleCancel}>
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            className="bg-blue-600 hover:bg-blue-700 text-white"
          >
            Continue to Authorization...
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

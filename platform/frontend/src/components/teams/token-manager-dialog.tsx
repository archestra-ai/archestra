"use client";
import { archestraApiSdk } from "@shared";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Key, RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type TeamToken, useRotateToken } from "@/lib/team-token.query";

interface TokenManagerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  token: TeamToken;
}

export function TokenManagerDialog({
  open,
  onOpenChange,
  token,
}: TokenManagerDialogProps) {
  const queryClient = useQueryClient();
  const [showValue, setShowValue] = useState(false);
  const [displayedValue, setDisplayedValue] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);

  const rotateMutation = useRotateToken();

  const handleShowToken = async () => {
    if (!showValue) {
      const response = await archestraApiSdk.getTokenValue({
        path: { tokenId: token.id },
      });
      const value = (response.data as { value: string })?.value;
      if (value) {
        setDisplayedValue(value);
        setShowValue(true);
      }
    } else {
      setShowValue(false);
    }
  };

  const handleCopy = async () => {
    if (displayedValue) {
      await navigator.clipboard.writeText(displayedValue);
      setCopied(true);
      toast.success("Token copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleRotate = async () => {
    if (!confirmRotate) {
      setConfirmRotate(true);
      return;
    }

    try {
      const result = await rotateMutation.mutateAsync(token.id);
      if (result?.value) {
        await navigator.clipboard.writeText(result.value);
        toast.success("Token rotated and copied to clipboard");
        // Show the new rotated value immediately
        setDisplayedValue(result.value);
        setShowValue(true);
        setConfirmRotate(false);
        // Invalidate the token value cache
        queryClient.invalidateQueries({ queryKey: ["tokenValue", token.id] });
      }
    } catch {
      // Error handled in mutation
    }
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      setShowValue(false);
      setDisplayedValue(null);
      setConfirmRotate(false);
    }
    onOpenChange(open);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Key className="h-5 w-5" />
            {token.name}
          </DialogTitle>
          <DialogDescription>
            {token.teamId
              ? `Token for ${token.team?.name || "team"} access`
              : "Organization-wide access token"}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label>Token Preview</Label>
            <div className="flex gap-2">
              <Input
                readOnly
                value={
                  showValue && displayedValue
                    ? displayedValue
                    : `${displayedValue ? displayedValue.substring(0, 14) : token.tokenStart}...`
                }
                className="font-mono"
              />
              <Button
                variant="outline"
                size="icon"
                onClick={handleShowToken}
                title={showValue ? "Hide token" : "Show token"}
              >
                <Key className="h-4 w-4" />
              </Button>
              {showValue && displayedValue && (
                <Button
                  variant="outline"
                  size="icon"
                  onClick={handleCopy}
                  title="Copy token"
                >
                  {copied ? (
                    <Check className="h-4 w-4 text-green-500" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              )}
            </div>
          </div>

          <div className="space-y-1 text-sm text-muted-foreground">
            <p>
              <strong>Created:</strong>{" "}
              {new Date(token.createdAt).toLocaleDateString()}
            </p>
            {token.lastUsedAt && (
              <p>
                <strong>Last used:</strong>{" "}
                {new Date(token.lastUsedAt).toLocaleDateString()}
              </p>
            )}
          </div>

          {confirmRotate && (
            <Alert variant="destructive">
              <AlertDescription>
                Rotating this token will invalidate the current value. Any
                applications using this token will need to be updated. Click
                Rotate again to confirm.
              </AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter className="flex justify-between sm:justify-between">
          <Button
            variant={confirmRotate ? "destructive" : "outline"}
            onClick={handleRotate}
            disabled={rotateMutation.isPending}
          >
            <RefreshCw
              className={`mr-2 h-4 w-4 ${rotateMutation.isPending ? "animate-spin" : ""}`}
            />
            {confirmRotate ? "Confirm Rotate" : "Rotate Token"}
          </Button>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

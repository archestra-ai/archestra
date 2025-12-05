"use client";

import { Copy, Key, RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  useProfileTokens,
  useRotateProfileToken,
} from "@/lib/profile-token.query";
import { LoadingSpinner } from "./loading";

interface ProfileTokenManagerProps {
  profileId: string;
}

export function ProfileTokenManager({ profileId }: ProfileTokenManagerProps) {
  const { data: tokens, isLoading } = useProfileTokens(profileId);
  const rotateToken = useRotateProfileToken();

  const [rotateDialogOpen, setRotateDialogOpen] = useState(false);
  const [selectedTokenId, setSelectedTokenId] = useState<string | null>(null);
  const [rotatedTokenValue, setRotatedTokenValue] = useState<string | null>(
    null,
  );

  const handleRotate = async () => {
    if (!selectedTokenId) return;
    const result = await rotateToken.mutateAsync({
      profileId,
      tokenId: selectedTokenId,
    });
    if (result?.value) {
      setRotatedTokenValue(result.value);
      await navigator.clipboard.writeText(result.value);
      toast.success("Token rotated and copied to clipboard");
    }
  };

  const copyToClipboard = async () => {
    if (rotatedTokenValue) {
      await navigator.clipboard.writeText(rotatedTokenValue);
      toast.success("Token copied to clipboard");
    }
  };

  const openRotateDialog = (tokenId: string) => {
    setSelectedTokenId(tokenId);
    setRotatedTokenValue(null);
    setRotateDialogOpen(true);
  };

  const formatDate = (date: string | null) => {
    if (!date) return "Never";
    return new Date(date).toLocaleDateString();
  };

  const maskToken = (token: string) => {
    // Show archestra_ + first 4 chars, mask the rest with dots
    const visiblePart = token.substring(0, 14); // "archestra_" (10) + 4 chars
    const maskedPart = "•".repeat(token.length - 14);
    return visiblePart + maskedPart;
  };

  if (isLoading) {
    return <LoadingSpinner />;
  }

  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-sm font-medium">Access Tokens</h4>
        <p className="text-xs text-muted-foreground">
          Tokens for authenticating with the MCP Gateway. Tokens are
          automatically managed based on team assignments.
        </p>
      </div>

      {tokens && tokens.length > 0 ? (
        <div className="border rounded-md">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Token</TableHead>
                <TableHead className="w-[50px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {tokens.map((token) => (
                <TableRow key={token.id}>
                  <TableCell className="font-medium relative">
                    <div className="flex items-center gap-2">
                      <Key className="h-4 w-4 text-muted-foreground" />
                      <div className="text-sm pb-2 relative">
                        {token.name}{" "}
                        <div className="text-[11px] text-muted-foreground absolute bottom-[-8px] w-[max-content]">
                          Last used: {formatDate(token.lastUsedAt)}
                        </div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    {token.isOrganizationToken ? (
                      <Badge variant="secondary">Whole Organization</Badge>
                    ) : token.team ? (
                      <Badge variant="outline">{token.team.name}</Badge>
                    ) : (
                      <span className="text-muted-foreground text-sm">
                        No team
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <code className="text-xs bg-muted px-1 py-0.5 rounded">
                      {token.tokenStart}...
                    </code>
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => openRotateDialog(token.id)}
                      title="Rotate token"
                      className="relative right-2"
                    >
                      <RefreshCw className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="border rounded-md p-4 text-center text-sm text-muted-foreground">
          No tokens available. Tokens will be created automatically when the
          profile is assigned to teams.
        </div>
      )}

      <Dialog open={rotateDialogOpen} onOpenChange={setRotateDialogOpen}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>Rotate Token</DialogTitle>
            <DialogDescription>
              {rotatedTokenValue
                ? "Your new token has been generated and copied to clipboard."
                : "Rotating this token will invalidate the current value. Any clients using this token will need to be updated with the new value."}
            </DialogDescription>
          </DialogHeader>

          {rotatedTokenValue ? (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <code className="flex-1 bg-muted p-2 rounded text-sm break-all">
                  {maskToken(rotatedTokenValue)}
                </code>
                <Button size="icon" variant="outline" onClick={copyToClipboard}>
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">
                This token will not be shown again after closing this dialog.
              </p>
            </div>
          ) : (
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setRotateDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button onClick={handleRotate} disabled={rotateToken.isPending}>
                {rotateToken.isPending ? "Rotating..." : "Rotate Token"}
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

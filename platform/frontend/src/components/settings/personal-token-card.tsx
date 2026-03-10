"use client";

import { archestraApiSdk } from "@shared";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Key, RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { WithPermissions } from "@/components/roles/with-permissions";
import { TokenManagerDialog } from "@/components/teams/token-manager-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PermissionButton } from "@/components/ui/permission-button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { type TeamToken, useTokens } from "@/lib/team-token.query";
import { useRotateUserToken, useUserToken } from "@/lib/user-token.query";

export function PersonalTokenCard() {
  const queryClient = useQueryClient();
  const { data: token, isLoading, error } = useUserToken();
  const rotateMutation = useRotateUserToken();

  const [copied, setCopied] = useState(false);
  const [isCopying, setIsCopying] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);

  // Organization token state
  const { data: tokensData, isLoading: tokensLoading } = useTokens();
  const tokens = tokensData?.tokens;
  const [selectedToken, setSelectedToken] = useState<TeamToken | null>(null);
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false);

  const handleCopy = async () => {
    if (!token) return;

    setIsCopying(true);
    try {
      const response = await archestraApiSdk.getUserTokenValue();
      const value = (response.data as { value: string })?.value;
      if (value) {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        toast.success("Token copied to clipboard");
        setTimeout(() => setCopied(false), 2000);
      }
    } finally {
      setIsCopying(false);
    }
  };

  const handleRotate = async () => {
    if (!confirmRotate) {
      setConfirmRotate(true);
      return;
    }

    try {
      const result = await rotateMutation.mutateAsync();
      if (result?.value) {
        await navigator.clipboard.writeText(result.value);
        toast.success("Token rotated and copied to clipboard");
        setConfirmRotate(false);
        queryClient.invalidateQueries({ queryKey: ["userTokenValue"] });
      }
    } catch {
      // Error handled in mutation
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>MCP Gateway/A2A Gateway Tokens</CardTitle>
          <CardDescription>
            Your personal token to authenticate with the MCP Gateway for
            profiles you have access to through your team memberships.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-10 w-full" />
          </div>
          <Skeleton className="h-4 w-48" />
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>MCP Gateway/A2A Gateway Tokens</CardTitle>
          <CardDescription>
            Your personal token to authenticate with the MCP Gateway for
            profiles you have access to through your team memberships.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive">
            <AlertDescription>
              Failed to load personal token. Please try refreshing the page.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  const orgToken = tokens?.find((t) => t.isOrganizationToken);

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>MCP Gateway/A2A Gateway Tokens</CardTitle>
          <CardDescription>
            Your personal token to authenticate with the MCP Gateway for
            profiles you have access to through your team memberships.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Personal Token Section */}
          <div className="space-y-2">
            <Label>Personal Token</Label>
            <div className="flex gap-2">
              <Input
                readOnly
                value={`${token?.tokenStart || "archestra_"}***`}
                className="font-mono"
              />
              <Button
                variant="outline"
                size="icon"
                onClick={handleCopy}
                disabled={isCopying}
                title="Copy token"
              >
                {isCopying ? (
                  <RefreshCw className="h-4 w-4 animate-spin" />
                ) : copied ? (
                  <Check className="h-4 w-4 text-green-500" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>

          <div className="space-y-1 text-sm text-muted-foreground">
            {token?.createdAt && (
              <p>
                <strong>Created:</strong>{" "}
                {new Date(token.createdAt).toLocaleDateString()}
              </p>
            )}
            {token?.lastUsedAt && (
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

          <div className="flex justify-start">
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
          </div>

          {/* Organization Token Section */}
          <WithPermissions
            permissions={{ team: ["update"] }}
            noPermissionHandle="hide"
          >
            <Separator />
            <div className="space-y-3">
              <Label>Organization Token</Label>
              <p className="text-sm text-muted-foreground">
                Organization-wide authentication token for MCP Gateway access
              </p>
              {tokensLoading ? (
                <div className="space-y-2">
                  <Skeleton className="h-4 w-16" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ) : orgToken ? (
                <div className="flex flex-col md:flex-row md:items-center md:justify-between rounded-lg border p-4 gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="font-mono text-sm text-muted-foreground truncate">
                      {orgToken.tokenStart}...
                    </p>
                  </div>
                  <PermissionButton
                    permissions={{ team: ["update"] }}
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setSelectedToken(orgToken);
                      setTokenDialogOpen(true);
                    }}
                  >
                    <Key className="mr-2 h-4 w-4" />
                    Manage Token
                  </PermissionButton>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-4 text-center">
                  <Key className="mb-2 h-8 w-8 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    No organization token available. It will be automatically
                    created.
                  </p>
                </div>
              )}
            </div>
          </WithPermissions>
        </CardContent>
      </Card>

      {selectedToken && (
        <TokenManagerDialog
          open={tokenDialogOpen}
          onOpenChange={setTokenDialogOpen}
          token={selectedToken}
        />
      )}
    </>
  );
}

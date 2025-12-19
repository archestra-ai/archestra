"use client";

import { archestraApiSdk } from "@shared";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Eye, EyeOff, RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
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
import { Skeleton } from "@/components/ui/skeleton";
import { useRotateUserToken, useUserToken } from "@/lib/user-token.query";

export function PersonalTokenCard() {
  const queryClient = useQueryClient();
  const { data: token, isLoading, error } = useUserToken();
  const rotateMutation = useRotateUserToken();

  const [showValue, setShowValue] = useState(false);
  const [displayedValue, setDisplayedValue] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [isLoadingValue, setIsLoadingValue] = useState(false);

  const handleShowToken = async () => {
    if (!showValue && token) {
      setIsLoadingValue(true);
      try {
        const response = await archestraApiSdk.getUserTokenValue();
        const value = (response.data as { value: string })?.value;
        if (value) {
          setDisplayedValue(value);
          setShowValue(true);
        }
      } finally {
        setIsLoadingValue(false);
      }
    } else {
      setShowValue(false);
      setDisplayedValue(null);
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
      const result = await rotateMutation.mutateAsync();
      if (result?.value) {
        await navigator.clipboard.writeText(result.value);
        toast.success("Token rotated and copied to clipboard");
        setDisplayedValue(result.value);
        setShowValue(true);
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
          <CardTitle>MCP Gateway Token</CardTitle>
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
          <CardTitle>MCP Gateway Token</CardTitle>
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

  return (
    <Card>
      <CardHeader>
        <CardTitle>MCP Gateway Token</CardTitle>
        <CardDescription>
          Your personal token to authenticate with the MCP Gateway for profiles
          you have access to through your team memberships.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label>Token</Label>
          <div className="flex gap-2">
            <Input
              readOnly
              value={
                showValue && displayedValue
                  ? displayedValue
                  : `${token?.tokenStart || "archestra_"}...`
              }
              className="font-mono"
            />
            <Button
              variant="outline"
              size="icon"
              onClick={handleShowToken}
              disabled={isLoadingValue}
              title={showValue ? "Hide token" : "Show token"}
            >
              {isLoadingValue ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : showValue ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
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
      </CardContent>
    </Card>
  );
}

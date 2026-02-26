"use client";

import { Loader2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  useInstallMcpServer,
  useReauthenticateMcpServer,
} from "@/lib/mcp-server.query";
import { useHandleOAuthCallback } from "@/lib/oauth.query";
import {
  clearCallbackProcessing,
  clearInstallContext,
  clearReauthContext,
  getOAuthEnvironmentValues,
  getOAuthIsFirstInstallation,
  getOAuthMcpServerId,
  getOAuthServerType,
  getOAuthTeamId,
  isCallbackProcessed,
  markCallbackProcessing,
  setOAuthInstallationCompleteCatalogId,
} from "@/lib/oauth-session";

function OAuthCallbackContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const installMutation = useInstallMcpServer();
  const reauthMutation = useReauthenticateMcpServer();
  const callbackMutation = useHandleOAuthCallback();

  // biome-ignore lint/correctness/useExhaustiveDependencies: Mutation objects and router change reference on every render. Using stable function references prevents unnecessary re-executions. Effect is guarded by sessionStorage to run only once per callback.
  useEffect(() => {
    const handleOAuthCallback = async () => {
      const code = searchParams.get("code");
      const error = searchParams.get("error");
      const state = searchParams.get("state");

      if (!code || !state) {
        toast.error(
          error
            ? `OAuth error: ${error}`
            : !code
              ? "No authorization code received"
              : "Missing OAuth state",
        );
        router.push("/mcp-catalog");
        return;
      }

      // Prevent duplicate processing (persists across React Strict Mode remounts)
      if (isCallbackProcessed(code, state)) {
        return;
      }
      markCallbackProcessing(code, state);

      try {
        // Exchange authorization code for access token
        const { catalogId, name, secretId } =
          await callbackMutation.mutateAsync({ code, state });

        // Check if this is a re-authentication flow
        const mcpServerId = getOAuthMcpServerId();

        if (mcpServerId) {
          // Re-authentication: update existing server with new secret
          await reauthMutation.mutateAsync({
            id: mcpServerId,
            secretId,
            name,
          });

          clearCallbackProcessing(code, state);
          clearReauthContext();
        } else {
          // New installation flow
          const teamId = getOAuthTeamId();
          const serverType = getOAuthServerType();
          const environmentValues = getOAuthEnvironmentValues();

          // Install the MCP server with the secret reference
          await installMutation.mutateAsync({
            name,
            catalogId,
            secretId,
            teamId: teamId || undefined,
            // For local servers: include environment values collected before OAuth redirect
            ...(serverType === "local" &&
              environmentValues && { environmentValues }),
          });

          const isFirstInstallation = getOAuthIsFirstInstallation();

          clearCallbackProcessing(code, state);
          clearInstallContext();

          // Store flag to open assignments dialog after redirect (only for first installation)
          if (isFirstInstallation) {
            setOAuthInstallationCompleteCatalogId(catalogId);
          }
        }

        // Redirect back to MCP catalog immediately
        // The mutation's onSuccess handler will show the success toast
        router.push("/mcp-catalog");
      } catch (error) {
        console.error("OAuth completion error:", error);
        // The mutation's onError handler will show the error toast
        // Redirect back to catalog
        router.push("/mcp-catalog");
      }
    };

    handleOAuthCallback();
  }, [
    searchParams,
    callbackMutation.mutateAsync,
    installMutation.mutateAsync,
    reauthMutation.mutateAsync,
    router.push,
  ]);

  // This component always redirects on success or error, so just show loading state
  return (
    <div className="container mx-auto p-6 max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle>OAuth Authentication</CardTitle>
          <CardDescription>Processing authentication...</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center space-y-4">
            <Loader2 className="h-12 w-12 animate-spin text-blue-600" />
            <p className="text-center text-muted-foreground">
              Completing OAuth authentication and installing MCP server...
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function LoadingFallback() {
  return (
    <div className="container mx-auto p-6 max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle>OAuth Authentication</CardTitle>
          <CardDescription>Initializing OAuth flow...</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center space-y-4">
            <Loader2 className="h-12 w-12 animate-spin text-blue-600" />
            <p className="text-center text-muted-foreground">
              Preparing to complete authentication...
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function OAuthCallbackPage() {
  return (
    <Suspense fallback={<LoadingFallback />}>
      <OAuthCallbackContent />
    </Suspense>
  );
}

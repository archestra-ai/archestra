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

      // Create a unique key for this OAuth callback to prevent duplicate processing
      // This persists across React Strict Mode unmount/remount cycles
      const processKey = `oauth_processing_${code}_${state}`;

      // Check if we've already processed this callback
      if (sessionStorage.getItem(processKey)) {
        return;
      }

      // Mark as processing immediately
      sessionStorage.setItem(processKey, "true");

      if (error) {
        sessionStorage.removeItem(processKey);
        toast.error(`OAuth error: ${error}`);
        router.push("/mcp-catalog");
        return;
      }

      if (!code) {
        sessionStorage.removeItem(processKey);
        toast.error("No authorization code received");
        router.push("/mcp-catalog");
        return;
      }

      if (!state) {
        sessionStorage.removeItem(processKey);
        toast.error("Missing OAuth state");
        router.push("/mcp-catalog");
        return;
      }

      try {
        // Exchange authorization code for access token
        const { catalogId, name, secretId } =
          await callbackMutation.mutateAsync({ code, state });

        // Check if this is a re-authentication flow
        const mcpServerId = sessionStorage.getItem("oauth_mcp_server_id");

        if (mcpServerId) {
          // Re-authentication: update existing server with new secret
          await reauthMutation.mutateAsync({
            id: mcpServerId,
            secretId,
            name,
          });

          // Clean up session storage
          sessionStorage.removeItem(processKey);
          sessionStorage.removeItem("oauth_mcp_server_id");
        } else {
          // New installation flow
          // Get teamId from session storage (stored before OAuth redirect)
          const teamId = sessionStorage.getItem("oauth_team_id");

          // Install the MCP server with the secret reference
          await installMutation.mutateAsync({
            name,
            catalogId,
            secretId,
            teamId: teamId || undefined,
          });

          // Check if this was a first installation
          const isFirstInstallation =
            sessionStorage.getItem("oauth_is_first_installation") === "true";

          // Clean up the processing flag and teamId after successful installation
          sessionStorage.removeItem(processKey);
          sessionStorage.removeItem("oauth_team_id");
          sessionStorage.removeItem("oauth_is_first_installation");

          // Store flag to open assignments dialog after redirect (only for first installation)
          if (isFirstInstallation) {
            sessionStorage.setItem(
              "oauth_installation_complete_catalog_id",
              catalogId,
            );
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

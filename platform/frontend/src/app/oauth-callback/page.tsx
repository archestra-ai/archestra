"use client";

import { AlertCircle, Loader2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useHandleOAuthCallback } from "@/lib/auth/oauth.query";
import {
  clearCallbackProcessing,
  clearInstallContext,
  clearOAuthReauthChatResume,
  clearOAuthReturnUrl,
  clearReauthContext,
  getOAuthEnvironmentValues,
  getOAuthIsFirstInstallation,
  getOAuthMcpServerId,
  getOAuthReturnUrl,
  getOAuthScope,
  getOAuthServerType,
  getOAuthTeamId,
  getOAuthUserConfigValues,
  isCallbackProcessed,
  markCallbackProcessing,
  setOAuthInstallationCompleteCatalogId,
  setOAuthReauthChatResume,
} from "@/lib/auth/oauth-session";
import {
  useInstallMcpServer,
  useReauthenticateMcpServer,
} from "@/lib/mcp/mcp-server.query";
import { replaceBrowserUrl } from "@/lib/utils/browser-redirect";
import {
  getOAuthCallbackErrorState,
  type OAuthCallbackErrorState,
} from "./oauth-callback.utils";

function OAuthCallbackContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const installMutation = useInstallMcpServer();
  const reauthMutation = useReauthenticateMcpServer();
  const callbackMutation = useHandleOAuthCallback();
  const [callbackError, setCallbackError] =
    useState<OAuthCallbackErrorState | null>(null);

  useEffect(() => {
    const handleOAuthCallback = async () => {
      const code = searchParams.get("code");
      const error = searchParams.get("error");
      const errorDescription = searchParams.get("error_description");
      const state = searchParams.get("state");

      const initialError = getOAuthCallbackErrorState({
        code,
        error,
        errorDescription,
        state,
      });

      if (initialError) {
        setCallbackError(initialError);
        return;
      }

      if (!code || !state) {
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
          const returnUrl = getOAuthReturnUrl();

          await reauthMutation.mutateAsync({
            id: mcpServerId,
            secretId,
            name,
          });

          clearCallbackProcessing(code, state);
          clearReauthContext();
          clearOAuthReturnUrl();

          // Redirect back to where the user was (e.g. chat page)
          if (returnUrl) {
            setOAuthReauthChatResume({ returnUrl, serverName: name });
            replaceBrowserUrl(returnUrl);
            return;
          }
        } else {
          // New installation flow
          const teamId = getOAuthTeamId();
          const scope = getOAuthScope() ?? (teamId ? "team" : "personal");
          const serverType = getOAuthServerType();
          const environmentValues = getOAuthEnvironmentValues();
          const userConfigValues = getOAuthUserConfigValues();

          // Install the MCP server with the secret reference
          await installMutation.mutateAsync({
            name,
            catalogId,
            secretId,
            scope,
            ...(scope === "team" && teamId ? { teamId } : {}),
            // For local servers: include environment values collected before OAuth redirect
            ...(serverType === "local" &&
              environmentValues && { environmentValues }),
            ...(serverType === "local" &&
              userConfigValues && { userConfigValues }),
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
        router.push("/mcp/registry");
      } catch (error) {
        console.error("OAuth completion error:", error);
        clearOAuthReauthChatResume();
        // The mutation's onError handler will show the error toast
        // Redirect back to catalog
        router.push("/mcp/registry");
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

  if (callbackError) {
    return (
      <OAuthCallbackLayout>
        <Card>
          <CardHeader>
            <CardTitle>OAuth Authentication</CardTitle>
            <CardDescription>
              Authentication could not be completed.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>{callbackError.title}</AlertTitle>
              <AlertDescription>{callbackError.description}</AlertDescription>
            </Alert>
            <Button onClick={() => router.push("/mcp/registry")}>
              Return to MCP Registry
            </Button>
          </CardContent>
        </Card>
      </OAuthCallbackLayout>
    );
  }

  return (
    <OAuthCallbackLayout>
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
    </OAuthCallbackLayout>
  );
}

function LoadingFallback() {
  return (
    <OAuthCallbackLayout>
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
    </OAuthCallbackLayout>
  );
}

function OAuthCallbackLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-[calc(100vh-8rem)] w-full max-w-2xl items-center justify-center p-6">
      <div className="w-full">{children}</div>
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

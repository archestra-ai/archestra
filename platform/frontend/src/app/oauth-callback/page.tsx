"use client";

import { AlertCircle, CheckCircle, Loader2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useInstallMcpServer } from "@/lib/mcp-server.query";

export default function OAuthCallbackPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [status, _setStatus] = useState<
    "waiting" | "processing" | "success" | "error"
  >("waiting");
  const [errorMessage, _setErrorMessage] = useState<string>("");
  const installMutation = useInstallMcpServer();

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
        const response = await fetch("/api/oauth/callback", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            code,
            state,
          }),
        });

        if (!response.ok) {
          sessionStorage.removeItem(processKey);
          const errorData = await response.json();
          throw new Error(
            errorData.error?.message || "Failed to complete OAuth",
          );
        }

        const { catalogId, name, secretId } = await response.json();

        // Retrieve teams from sessionStorage if they were stored
        const teamsJson = sessionStorage.getItem("oauth_teams");
        const teams = teamsJson ? JSON.parse(teamsJson) : [];

        // Install the MCP server with the secret reference and teams
        await installMutation.mutateAsync({
          name,
          catalogId,
          secretId,
          teams,
        });

        // Clean up teams from sessionStorage
        sessionStorage.removeItem("oauth_teams");

        // Clean up the processing flag after successful installation
        sessionStorage.removeItem(processKey);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    searchParams,
    installMutation.mutateAsync, // The mutation's onError handler will show the error toast
    // Redirect back to catalog
    router.push,
  ]);

  return (
    <div className="container mx-auto p-6 max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle>OAuth Authentication</CardTitle>
          <CardDescription>
            {status === "waiting" && "Initializing OAuth flow..."}
            {status === "processing" && "Processing authentication..."}
            {status === "success" && "Authentication successful!"}
            {status === "error" && "Authentication failed"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {status === "waiting" && (
            <div className="flex flex-col items-center space-y-4">
              <Loader2 className="h-12 w-12 animate-spin text-blue-600" />
              <p className="text-center text-muted-foreground">
                Preparing to complete authentication...
              </p>
            </div>
          )}

          {status === "processing" && (
            <div className="flex flex-col items-center space-y-4">
              <Loader2 className="h-12 w-12 animate-spin text-blue-600" />
              <p className="text-center text-muted-foreground">
                Completing OAuth authentication and installing MCP server...
              </p>
            </div>
          )}

          {status === "success" && (
            <Alert className="border-green-200 bg-green-50">
              <CheckCircle className="h-4 w-4 text-green-600" />
              <AlertTitle>Success!</AlertTitle>
              <AlertDescription>
                The MCP server has been successfully installed with OAuth
                authentication. Redirecting to MCP catalog...
              </AlertDescription>
            </Alert>
          )}

          {status === "error" && (
            <div className="space-y-4">
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Authentication Error</AlertTitle>
                <AlertDescription>{errorMessage}</AlertDescription>
              </Alert>

              <div className="flex justify-center">
                <Button onClick={() => router.push("/mcp-catalog")}>
                  Back to MCP Catalog
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

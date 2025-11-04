"use client";

import type { ArchestraMcpServerManifest } from "@shared/hey-api/clients/archestra-catalog/types.gen";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  useApproveMcpServerInstallationRequest,
  useCreateMcpServerInstallationRequest,
} from "@/lib/mcp-server-installation-request.query";
import OnboardingStep from "../onboarding-step";

interface McpServerInstallationProps {
  isActive: boolean;
  isNextStep: boolean;
  isTransitioning: boolean;
  server: ArchestraMcpServerManifest | null;
  agentId: string;
  onComplete: (serverId: string) => void;
}

export function McpServerInstallation({
  isActive,
  isNextStep,
  isTransitioning,
  server,
  agentId,
  onComplete,
}: McpServerInstallationProps) {
  const [oauthCompleted, setOauthCompleted] = useState(false);
  const hasStartedRef = useRef(false);
  const installMcpServer = useCreateMcpServerInstallationRequest();
  const approveMutation = useApproveMcpServerInstallationRequest();

  // Check if server requires OAuth
  const requiresOAuth = server?.archestra_config?.oauth?.required ?? false;

  // Listen for OAuth completion from popup window
  useEffect(() => {
    const handleOAuthMessage = (event: MessageEvent) => {
      // Verify origin
      if (event.origin !== window.location.origin) return;

      if (event.data.type === "OAUTH_SUCCESS") {
        setOauthCompleted(true);
        toast.success("OAuth authentication successful!");
        // Complete the onboarding step
        setTimeout(() => {
          onComplete(event.data.secretId);
        }, 1000);
      }
    };

    window.addEventListener("message", handleOAuthMessage);
    return () => window.removeEventListener("message", handleOAuthMessage);
  }, [onComplete]);

  useEffect(() => {
    if (isActive && !hasStartedRef.current && agentId && server) {
      hasStartedRef.current = true;

      // OAuth path: Create installation request first, then redirect to OAuth
      if (requiresOAuth) {
        const handleOAuthFlow = async () => {
          try {
            // Step 1: Create installation request
            const installationRequest = await installMcpServer.mutateAsync({
              externalCatalogId: server.name,
              customServerConfig: null,
            });

            if (!installationRequest) {
              throw new Error("Failed to create installation request");
            }

            // Step 2: Approve the request - this creates the internal catalog item and returns catalogId
            const approvalResponse = await approveMutation.mutateAsync({
              id: installationRequest.id,
            });

            if (!approvalResponse?.catalogId) {
              throw new Error(
                "Failed to create catalog item - no catalogId returned",
              );
            }

            // Store onboarding context for resumption after OAuth
            sessionStorage.setItem("onboarding_agent_id", agentId);
            sessionStorage.setItem("onboarding_step", "4"); // Store step number as string
            sessionStorage.setItem("onboarding_server_name", server.name);

            // Step 3: Initiate OAuth flow using fetch (same as InternalMCPCatalog)
            const response = await fetch("/api/oauth/initiate", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                catalogId: approvalResponse.catalogId,
              }),
            });

            if (!response.ok) {
              throw new Error("Failed to initiate OAuth flow");
            }

            const { authorizationUrl, state } = await response.json();

            // Store OAuth state
            sessionStorage.setItem("oauth_state", state);
            sessionStorage.setItem(
              "oauth_catalog_id",
              approvalResponse.catalogId,
            );
            sessionStorage.setItem("oauth_teams", JSON.stringify([]));

            // Redirect to OAuth - when user comes back, oauth-callback will handle the redirect
            window.location.href = authorizationUrl;
          } catch (error) {
            console.error("OAuth initiation failed:", error);
            toast.error(
              error instanceof Error
                ? error.message
                : "Failed to start OAuth authentication",
            );
            hasStartedRef.current = false;
          }
        };

        handleOAuthFlow();
        return;
      }

      // Non-OAuth path: Direct installation
      installMcpServer.mutateAsync(
        {
          externalCatalogId: server?.name,
          customServerConfig: null,
        },
        {
          onSuccess: (data) => {
            if (data) {
              approveMutation.mutateAsync({
                id: data.id,
              });
              setTimeout(() => {
                onComplete(data.id);
              }, 1500);
            }
          },
          onError: (error) => {
            console.error("Failed to install MCP server:", error);
            // Could show error UI here
          },
        },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, agentId]);

  const isInstalling = installMcpServer.isPending;
  const isSuccess = installMcpServer.isSuccess;
  const isError = installMcpServer.isError;

  return (
    <OnboardingStep
      title="Installing MCP Server"
      description={
        requiresOAuth
          ? "Redirecting to OAuth authentication..."
          : isSuccess
            ? "MCP server installed successfully!"
            : isError
              ? "Installation failed. Please try again."
              : "Setting up your MCP server and discovering tools..."
      }
      isActive={isActive}
      isTransitioning={isTransitioning}
      isNextStep={isNextStep}
    >
      <div className="space-y-3">
        {requiresOAuth && !oauthCompleted && (
          <div className="flex items-center gap-2">
            <div className="h-2 w-2 rounded-full bg-blue-500 animate-spin" />
            <span className="text-sm text-slate-400">
              {hasStartedRef.current
                ? "Waiting for OAuth authentication..."
                : "Preparing OAuth authentication..."}
            </span>
          </div>
        )}

        {requiresOAuth && oauthCompleted && (
          <div className="flex items-center gap-2 text-sm text-green-400">
            <div className="h-2 w-2 rounded-full bg-green-500" />
            <span>OAuth authentication complete!</span>
          </div>
        )}

        {server && isInstalling && !requiresOAuth && (
          <>
            <div className="flex items-center gap-2">
              <div className="h-2 w-2 rounded-full bg-blue-500 animate-spin" />
              <span className="text-sm text-slate-400">
                Installing {server.name}...
              </span>
            </div>
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <div className="h-1 w-1 rounded-full bg-slate-600" />
              <span>Downloading dependencies</span>
            </div>
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <div className="h-1 w-1 rounded-full bg-slate-600" />
              <span>Starting server</span>
            </div>
          </>
        )}

        {isSuccess && (
          <div className="flex items-center gap-2 text-sm text-green-400">
            <div className="h-2 w-2 rounded-full bg-green-500" />
            <span>Installation complete!</span>
          </div>
        )}

        {isError && (
          <div className="flex items-center gap-2 text-sm text-red-400">
            <div className="h-2 w-2 rounded-full bg-red-500" />
            <span>Installation failed. Please try again.</span>
          </div>
        )}
      </div>
    </OnboardingStep>
  );
}

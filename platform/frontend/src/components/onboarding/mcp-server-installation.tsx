"use client";

import { useEffect, useState } from "react";
import { useInstallMcpServer } from "@/lib/mcp-server.query";
import OnboardingStep from "../onboarding-step";

interface McpServerInstallationProps {
  isActive: boolean;
  isTransitioning: boolean;
  catalogId: string;
  catalogName: string;
  agentId: string;
  onComplete: (serverId: string) => void;
}

export function McpServerInstallation({
  isActive,
  isTransitioning,
  catalogId,
  catalogName,
  agentId,
  onComplete,
}: McpServerInstallationProps) {
  const [installationStarted, setInstallationStarted] = useState(false);
  const installMcpServer = useInstallMcpServer();

  useEffect(() => {
    if (isActive && !installationStarted && catalogId && agentId) {
      setInstallationStarted(true);

      installMcpServer.mutate(
        {
          name: catalogName,
          catalogId,
        },
        {
          onSuccess: (data) => {
            if (data) {
              // Wait a bit to show success, then advance
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
  }, [
    isActive,
    installationStarted,
    catalogId,
    catalogName,
    agentId,
    installMcpServer,
    onComplete,
  ]);

  const isInstalling = installMcpServer.isPending;
  const isSuccess = installMcpServer.isSuccess;
  const isError = installMcpServer.isError;

  return (
    <OnboardingStep
      title="Installing MCP Server"
      description={
        isSuccess
          ? "MCP server installed successfully!"
          : isError
            ? "Installation failed. Please try again."
            : "Setting up your MCP server and discovering tools..."
      }
      isActive={isActive}
      isTransitioning={isTransitioning}
    >
      <div className="space-y-3">
        {isInstalling && (
          <>
            <div className="flex items-center gap-2">
              <div className="h-2 w-2 rounded-full bg-blue-500 animate-spin" />
              <span className="text-sm text-slate-400">
                Installing {catalogName}...
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

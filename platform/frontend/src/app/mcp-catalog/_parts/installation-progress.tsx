"use client";

import { FileText } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { McpLogsDialog } from "./mcp-logs-dialog";

type InstallationStatus =
  | "idle"
  | "pending"
  | "discovering-tools"
  | "success"
  | null;

interface InstallationProgressProps {
  status: InstallationStatus;
  serverId?: string;
  serverName?: string;
}

const PHASES = {
  pending: {
    progress: 33,
    description: "Starting the Deployment",
  },
  "discovering-tools": {
    progress: 66,
    description: "Discovering tools",
  },
  success: {
    progress: 100,
    description: "Installation complete",
  },
} as const;

/**
 * Hook that returns animated dots that cycle through ".", "..", "..."
 */
function useAnimatedDots(isActive: boolean) {
  const [dotCount, setDotCount] = useState(1);

  useEffect(() => {
    if (!isActive) {
      setDotCount(1);
      return;
    }

    const interval = setInterval(() => {
      setDotCount((prev) => (prev % 3) + 1);
    }, 400);

    return () => clearInterval(interval);
  }, [isActive]);

  return ".".repeat(dotCount);
}

/**
 * Hook that returns animated progress value that smoothly increments
 */
function useAnimatedProgress(targetProgress: number, isActive: boolean) {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (!isActive) {
      setProgress(0);
      return;
    }

    // Immediately set to target if we're at a specific phase
    if (targetProgress > 0) {
      setProgress(targetProgress);
    }

    // Slowly increment progress within the current phase range
    // This gives the user feedback that something is happening
    const interval = setInterval(() => {
      setProgress((prev) => {
        // Don't exceed the target progress
        if (prev >= targetProgress) return prev;
        // Slowly increment (0.5% per interval)
        return Math.min(prev + 0.5, targetProgress);
      });
    }, 100);

    return () => clearInterval(interval);
  }, [targetProgress, isActive]);

  return progress;
}

export function InstallationProgress({
  status,
  serverId,
  serverName,
}: InstallationProgressProps) {
  const [isLogsDialogOpen, setIsLogsDialogOpen] = useState(false);

  const phaseInfo = useMemo(() => {
    if (!status || status === "idle") return null;
    return PHASES[status as keyof typeof PHASES] ?? null;
  }, [status]);

  const isActive = status === "pending" || status === "discovering-tools";
  const targetProgress = phaseInfo?.progress ?? 0;
  const animatedProgress = useAnimatedProgress(targetProgress, isActive);
  const animatedDots = useAnimatedDots(isActive);

  // Build description with animated dots for active phases
  const description = useMemo(() => {
    if (!phaseInfo) return "";
    if (isActive) {
      return `${phaseInfo.description}${animatedDots}`;
    }
    return phaseInfo.description;
  }, [phaseInfo, isActive, animatedDots]);

  if (!status || status === "idle" || status === "success") {
    return null;
  }

  const installs = serverId
    ? [{ id: serverId, name: serverName || "Installation" }]
    : [];

  return (
    <div className="w-full space-y-2">
      <Progress value={animatedProgress} />
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{description}</span>
        {serverId && (
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            onClick={() => setIsLogsDialogOpen(true)}
          >
            <FileText className="h-3 w-3 mr-1" />
            More details
          </Button>
        )}
      </div>

      {serverId && (
        <McpLogsDialog
          open={isLogsDialogOpen}
          onOpenChange={setIsLogsDialogOpen}
          serverName={serverName || "MCP Server"}
          installs={installs}
          hideInstallationSelector
        />
      )}
    </div>
  );
}

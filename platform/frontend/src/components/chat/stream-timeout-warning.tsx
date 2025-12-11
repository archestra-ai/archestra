"use client";

import type { UIMessage } from "@ai-sdk/react";
import { AlertTriangle } from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface StreamTimeoutWarningProps {
  status: "ready" | "submitted" | "streaming" | "error";
  messages: UIMessage[];
  thresholdSeconds?: number;
  checkIntervalSeconds?: number;
}

export function StreamTimeoutWarning({
  status,
  messages,
  thresholdSeconds = 40,
  checkIntervalSeconds = 3,
}: StreamTimeoutWarningProps) {
  const [showWarning, setShowWarning] = useState(false);
  const lastMessageTimestamp = useRef<number>(Date.now());
  const checkIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Monitor for timeout when streaming
  useEffect(() => {
    if (status === "streaming") {
      // Start timeout check interval
      checkIntervalRef.current = setInterval(() => {
        const timeSinceLastMessage = Date.now() - lastMessageTimestamp.current;
        const threshold = thresholdSeconds * 1000;

        if (timeSinceLastMessage > threshold) {
          setShowWarning(true);
        }
      }, checkIntervalSeconds * 1000);
    } else {
      // Not streaming - clear warning and interval
      setShowWarning(false);
      if (checkIntervalRef.current) {
        clearInterval(checkIntervalRef.current);
        checkIntervalRef.current = null;
      }
    }

    // Cleanup on unmount or status change
    return () => {
      if (checkIntervalRef.current) {
        clearInterval(checkIntervalRef.current);
        checkIntervalRef.current = null;
      }
    };
  }, [status, thresholdSeconds, checkIntervalSeconds]);

  // Update timestamp when messages change
  useEffect(() => {
    if (status === "streaming" && messages.length > 0) {
      lastMessageTimestamp.current = Date.now();
      setShowWarning(false); // Clear warning on new message
    }
  }, [messages, status]);

  if (!showWarning) {
    return null;
  }

  return (
    <div className="bg-yellow-50 dark:bg-yellow-900/20 border-l-4 border-yellow-400 p-4">
      <div className="flex">
        <div className="flex-shrink-0">
          <AlertTriangle className="h-5 w-5 text-yellow-400" />
        </div>
        <div className="ml-3">
          <p className="text-sm text-yellow-700 dark:text-yellow-200">
            No new messages from assistant have been received for the last{" "}
            {thresholdSeconds} seconds as part of a single streaming response.
            This may indicate that the timeout configured for your cloud
            provider's load balancer is too low. We recommend increasing the
            timeout to at least 5 minutes.{" "}
            <a
              href="https://archestra.ai/docs/platform-deployment#cloud-provider-configuration-streaming-timeout-settings"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium underline hover:no-underline"
            >
              Learn more in our documentation
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}

"use client";

import { AlertTriangle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { getFrontendDocsUrl } from "@/lib/docs/docs";

interface StreamTimeoutWarningProps {
  status: "ready" | "submitted" | "streaming" | "error";
  transportActivitySequence: number;
  responseProgressSequence: number;
  thresholdSeconds?: number;
}

function useStreamIdle({
  status,
  activitySequence,
  thresholdSeconds,
}: {
  status: StreamTimeoutWarningProps["status"];
  activitySequence: number;
  thresholdSeconds: number;
}) {
  const [isIdle, setIsIdle] = useState(false);
  const latestActivitySequence = useRef(activitySequence);

  useEffect(() => {
    latestActivitySequence.current = activitySequence;

    if (status !== "submitted" && status !== "streaming") {
      setIsIdle(false);
      return;
    }

    setIsIdle(false);
    const observedActivitySequence = activitySequence;
    const timeout = setTimeout(() => {
      // Cleanup normally prevents stale timers, while this guard also covers a
      // timer firing in the same task as a newly committed activity signal.
      if (latestActivitySequence.current === observedActivitySequence) {
        setIsIdle(true);
      }
    }, thresholdSeconds * 1000);

    return () => clearTimeout(timeout);
  }, [status, activitySequence, thresholdSeconds]);

  return isIdle;
}

export function StreamTimeoutWarning({
  status,
  transportActivitySequence,
  responseProgressSequence,
  thresholdSeconds = 40,
}: StreamTimeoutWarningProps) {
  const docsUrl = getFrontendDocsUrl(
    "platform-deployment",
    "cloud-provider-configuration-streaming-timeout-settings",
  );
  const isTransportIdle = useStreamIdle({
    status,
    activitySequence: transportActivitySequence,
    thresholdSeconds,
  });
  const isResponseProgressIdle = useStreamIdle({
    status,
    activitySequence: responseProgressSequence,
    thresholdSeconds,
  });

  if (!isTransportIdle && !isResponseProgressIdle) {
    return null;
  }

  const isUpstreamIdle = !isTransportIdle && isResponseProgressIdle;

  return (
    <div className="bg-yellow-50 dark:bg-yellow-900/20 border-l-4 border-yellow-400 p-4">
      <div className="flex">
        <div className="flex-shrink-0">
          <AlertTriangle className="h-5 w-5 text-yellow-400" />
        </div>
        <div className="ml-3">
          <p className="text-sm text-yellow-700 dark:text-yellow-200">
            {isUpstreamIdle ? (
              <>
                No response progress has been received for the last{" "}
                {thresholdSeconds} seconds. The upstream provider may still be
                processing or may have stalled. You can keep waiting, or stop
                and retry the response.
              </>
            ) : (
              <>
                No stream activity has been received for the last{" "}
                {thresholdSeconds} seconds. The connection may have stalled.
                Stop and retry the response. If this keeps happening and your
                deployment uses a load balancer, verify that its streaming
                timeout is at least 5 minutes.{" "}
              </>
            )}
            {!isUpstreamIdle && docsUrl && (
              <ExternalDocsLink
                href={docsUrl}
                className="font-medium underline hover:no-underline"
                showIcon={false}
              >
                Learn more in our documentation
              </ExternalDocsLink>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}

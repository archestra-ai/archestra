"use client";

import { AlertTriangle } from "lucide-react";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { TRANSPORT_STALL_THRESHOLD_SECONDS } from "@/lib/chat/stream-stall.hook";
import { getFrontendDocsUrl } from "@/lib/docs/docs";

/**
 * Shown when a run stops delivering bytes altogether — not even the backend's
 * heartbeat. That is a broken connection rather than a slow provider, so it
 * keeps the loud treatment and the deployment docs link. A provider that is
 * merely slow to start is reported quietly next to the chat's loading
 * indicator instead (see `useStreamStall`).
 */
export function StreamTimeoutWarning({ isStalled }: { isStalled: boolean }) {
  const docsUrl = getFrontendDocsUrl(
    "platform-deployment",
    "cloud-provider-configuration-streaming-timeout-settings",
  );

  if (!isStalled) {
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
            <span>
              No stream activity has been received for the last{" "}
              {TRANSPORT_STALL_THRESHOLD_SECONDS} seconds. The connection may
              have stalled. Stop and retry the response. If this keeps happening
              and your deployment uses a load balancer, verify that its
              streaming timeout is at least 5 minutes.{" "}
            </span>
            {docsUrl && (
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

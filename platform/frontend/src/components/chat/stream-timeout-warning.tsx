"use client";

import { AlertTriangle } from "lucide-react";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { TRANSPORT_STALL_THRESHOLD_SECONDS } from "@/lib/chat/stream-stall.hook";
import { getFrontendDocsUrl } from "@/lib/docs/docs";

/**
 * Shown when a run stops delivering bytes altogether — not even the backend's
 * heartbeat. That is a broken connection rather than a slow provider, so it
 * gets a notice of its own and the deployment docs link. A provider that is
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
    <InlineNotice>
      <AlertTriangle />
      <InlineNoticeText>
        No stream activity has been received for the last{" "}
        {TRANSPORT_STALL_THRESHOLD_SECONDS} seconds. The connection may have
        stalled. Stop and retry the response. If this keeps happening and your
        deployment uses a load balancer, verify that its streaming timeout is at
        least 5 minutes.{" "}
        {docsUrl && (
          <ExternalDocsLink
            href={docsUrl}
            className="font-medium underline hover:no-underline"
            showIcon={false}
          >
            Learn more in our documentation
          </ExternalDocsLink>
        )}
      </InlineNoticeText>
    </InlineNotice>
  );
}

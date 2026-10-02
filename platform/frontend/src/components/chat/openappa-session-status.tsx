"use client";

import { memo } from "react";
import { OpenAppaSolidIcon } from "@/components/openappa-icon";
import { useOpenappaStatus } from "@/lib/chat/chat.query";
import { useFeature } from "@/lib/config/config.query";
import { useGuardrailsDeployment } from "@/lib/guardrails-deployment.query";

/** The session readout stays outside the composer and its collapsing toolbar. */
export const OpenappaSessionStatus = memo(function OpenappaSessionStatus({
  conversationId,
}: {
  conversationId: string;
}) {
  const enabled = useFeature("openappaEnabled") === true;
  const { data: deployment } = useGuardrailsDeployment();
  const { data, isError } = useOpenappaStatus(
    enabled && deployment?.active ? conversationId : undefined,
  );
  // A failed refetch can retain cached data. Never present it as current.
  const status = isError ? null : data;
  if (!enabled || !deployment?.active) return null;

  const statusLabel = status
    ? `Trust: ${status.trust}; audience: ${status.audience}`
    : "Trust and audience status unavailable";

  return (
    <div className="relative z-10 mx-3 -mb-px flex min-w-0 max-w-[calc(100%-1.5rem)]">
      <div className="flex min-h-8 max-w-full items-center gap-2 rounded-t-lg border border-b-0 border-border bg-muted px-3 py-1.5 text-muted-foreground">
        <OpenAppaSolidIcon className="size-4 shrink-0" />
        <output
          aria-label={statusLabel}
          className="flex min-w-0 flex-wrap gap-x-3 gap-y-0.5 text-left font-mono text-[11px] leading-4 [overflow-wrap:anywhere]"
        >
          {status ? (
            <>
              <span>
                <span className="text-muted-foreground">trust:</span>
                <span className="text-foreground">{status.trust}</span>
              </span>
              <span>
                <span className="text-muted-foreground">audience:</span>
                <span className="text-foreground">{status.audience}</span>
              </span>
            </>
          ) : (
            <span>Status unavailable</span>
          )}
        </output>
      </div>
    </div>
  );
});

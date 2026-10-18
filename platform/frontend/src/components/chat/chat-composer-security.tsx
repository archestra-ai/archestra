"use client";

import { LockKeyhole } from "lucide-react";
import { memo, type ReactNode } from "react";
import { OpenAppaSolidIcon } from "@/components/openappa-icon";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useOpenappaStatus } from "@/lib/chat/chat.query";
import { useFeature } from "@/lib/config/config.query";
import { useGuardrailsDeployment } from "@/lib/guardrails-deployment.query";
import { cn } from "@/lib/utils/tailwind";

/** Started chats share one quiet rail for live guardrails and encrypted-chat privacy. */
export const ChatComposerSecurity = memo(function ChatComposerSecurity({
  conversationId,
  encrypted = false,
  privacyDetails,
  children,
}: {
  conversationId: string;
  encrypted?: boolean;
  privacyDetails?: ReactNode;
  children?: ReactNode;
}) {
  const enabled = useFeature("openappaEnabled") === true;
  const { data: deployment } = useGuardrailsDeployment();
  const { data, isError } = useOpenappaStatus(
    enabled && deployment?.active ? conversationId : undefined,
  );
  // A failed refetch can retain cached data. Never present it as current.
  const status = enabled && deployment?.active && !isError ? data : null;
  if (!encrypted && !status) return <>{children}</>;
  // A session that keeps the policy it opened with has no revision to name.
  const snapshot = status?.policyRevision === null;

  return (
    <div className="min-w-0">
      <div
        className={cn(
          "mx-3 -mb-px flex min-h-8 flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-t-lg border border-b-0 px-3",
          encrypted
            ? "border-dashed border-muted-foreground/60 bg-muted/50"
            : "border-input bg-muted/35",
        )}
      >
        {status && (
          <output
            aria-label={`Trust: ${status.trust}; audience: ${status.audience}${
              typeof status.policyRevision === "number"
                ? `; policy revision: ${status.policyRevision}`
                : snapshot
                  ? "; policy snapshot"
                  : ""
            }`}
            className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] leading-4 text-muted-foreground"
          >
            <OpenAppaSolidIcon
              aria-hidden="true"
              className="size-3.5 shrink-0"
            />
            <span className="min-w-0 [overflow-wrap:anywhere]">
              <span>trust:</span>
              <span className="font-medium text-foreground">
                {status.trust}
              </span>
            </span>
            <span className="min-w-0 [overflow-wrap:anywhere]">
              <span>audience:</span>
              <span className="font-medium text-foreground">
                {status.audience}
              </span>
            </span>
            {typeof status.policyRevision === "number" && (
              <span className="min-w-0 [overflow-wrap:anywhere]">
                <span>revision:</span>
                <span className="font-medium text-foreground">
                  {status.policyRevision}
                </span>
              </span>
            )}
            {snapshot && (
              <span className="min-w-0 font-medium text-foreground">
                policy snapshot
              </span>
            )}
          </output>
        )}
        {encrypted && (
          <Tooltip delayDuration={180}>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                className="-mr-1.5 ml-auto text-muted-foreground hover:text-foreground"
                aria-label="Encrypted chat privacy details"
              >
                <LockKeyhole aria-hidden="true" className="size-3.5" />
                <span>Encrypted</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent
              align="end"
              side="top"
              className="max-w-[min(24rem,calc(100vw-2rem))] text-left leading-relaxed"
            >
              {privacyDetails}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      {children}
    </div>
  );
});

"use client";

import type { archestraApiTypes } from "@archestra/shared";
import {
  ChevronRight,
  CornerDownRight,
  MessageSquareWarning,
} from "lucide-react";
import { useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { formatDate } from "@/lib/utils/date-time";
import { cn } from "@/lib/utils/tailwind";

export type SessionChatError =
  archestraApiTypes.GetLlmProxyLogSessionChatErrorsResponses["200"]["chatErrors"][number];

/**
 * The error cards the chat showed in this session. They are stored per
 * conversation, not on a request row, so a request that failed inside
 * Archestra after its usage came back still has a healthy-looking row; this
 * list is where that failure shows.
 */
export function SessionChatErrors({
  chatErrors,
  requestIdByErrorId,
  onShowRequest,
}: {
  chatErrors: SessionChatError[];
  /** The last request logged before each error, when it is known. */
  requestIdByErrorId: Map<string, string>;
  onShowRequest: (requestId: string) => void;
}) {
  if (chatErrors.length === 0) return null;

  return (
    <section
      aria-label="Failed turns"
      className="overflow-hidden rounded-lg border border-destructive/30 bg-card shadow-[0_1px_2px_0_rgb(0_0_0/0.03)]"
    >
      <header className="flex items-center gap-2 border-b border-destructive/20 bg-destructive/5 px-3 py-2">
        <MessageSquareWarning
          className="size-4 shrink-0 text-destructive"
          aria-hidden="true"
        />
        <h2 className="text-sm font-medium">Failed turns</h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          {chatErrors.length === 1
            ? "The user saw this error"
            : `The user saw these ${chatErrors.length} errors`}
        </span>
      </header>
      <ol className="divide-y">
        {chatErrors.map((chatError) => (
          <ChatErrorRow
            key={chatError.id}
            chatError={chatError}
            requestId={requestIdByErrorId.get(chatError.id) ?? null}
            onShowRequest={onShowRequest}
          />
        ))}
      </ol>
    </section>
  );
}

function ChatErrorRow({
  chatError,
  requestId,
  onShowRequest,
}: {
  chatError: SessionChatError;
  requestId: string | null;
  onShowRequest: (requestId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { error } = chatError;
  const original = error.originalError;
  const raw = JSON.stringify(error, null, 2);
  // One run of text, so it wraps like a sentence on a narrow screen instead
  // of stacking a line per fact.
  const facts = [
    <time
      key="at"
      dateTime={String(chatError.createdAt)}
      className="whitespace-nowrap"
    >
      {formatDate({
        date: String(chatError.createdAt),
        dateFormat: "MMM d, HH:mm:ss",
      })}
    </time>,
    error.code !== "unknown" ? (
      <span key="code" className="font-mono text-[11px]">
        {error.code}
      </span>
    ) : null,
    error.subagent ? (
      <span key="subagent">
        in sub-agent{" "}
        <span className="font-medium text-foreground">
          {error.subagent.name}
        </span>
      </span>
    ) : null,
    original?.status ? (
      <span key="status" className="tabular-nums">
        HTTP {original.status}
      </span>
    ) : null,
    <span key="retry" className="whitespace-nowrap">
      {error.isRetryable ? "Retryable" : "Not retryable"}
    </span>,
  ].filter((fact) => fact !== null);

  return (
    <li className="px-3 py-2.5">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-sm font-medium break-words">{error.message}</p>
            <p className="text-xs leading-5 text-muted-foreground">
              {facts.map((fact, index) => (
                <span key={fact.key}>
                  {index > 0 ? (
                    <span aria-hidden="true" className="px-1.5">
                      ·
                    </span>
                  ) : null}
                  {fact}
                </span>
              ))}
              {error.traceId ? (
                <span aria-hidden="true" className="px-1.5">
                  ·
                </span>
              ) : null}
              {error.traceId ? (
                <span className="inline-flex items-center gap-1 whitespace-nowrap">
                  <span>Trace</span>
                  <span className="font-mono text-[11px]">
                    {error.traceId.slice(0, 12)}
                  </span>
                  <CopyButton text={error.traceId} />
                </span>
              ) : null}
            </p>
          </div>
          <div className="-ml-2 flex shrink-0 items-center gap-1 sm:ml-0">
            {requestId ? (
              <Button
                size="xs"
                variant="ghost"
                onClick={() => onShowRequest(requestId)}
              >
                <CornerDownRight aria-hidden="true" />
                <span>Go to last request</span>
              </Button>
            ) : null}
            <CollapsibleTrigger asChild>
              <Button size="xs" variant="ghost" aria-expanded={open}>
                <ChevronRight
                  className={cn("transition-transform", open && "rotate-90")}
                  aria-hidden="true"
                />
                <span>Details</span>
              </Button>
            </CollapsibleTrigger>
          </div>
        </div>
        <CollapsibleContent>
          <div className="relative mt-2">
            <pre className="max-h-72 overflow-auto rounded-md border bg-muted/40 p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words">
              {raw}
            </pre>
            <span className="absolute top-1.5 right-1.5">
              <CopyButton text={raw} />
            </span>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

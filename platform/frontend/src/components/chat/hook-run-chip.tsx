"use client";

import {
  CheckCircleIcon,
  ChevronDownIcon,
  ClockIcon,
  WebhookIcon,
  XCircleIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { CodeBlock } from "@/components/ai-elements/code-block";
import { CopyButton } from "@/components/copy-button";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { prettyPrintJson, splitHookPayload } from "./hook-run-chip.utils";

export interface HookRunChipData {
  hookEventName?: string;
  fileName?: string;
  outcome?: string;
  exitCode?: number | null;
  toolName?: string;
  /** Debug bodies — only present when the conversation has hook debug mode on. */
  stdout?: string;
  stderr?: string;
  /** The received payload, JSON-stringified (capped). */
  payloadJson?: string;
  durationMs?: number;
}

// Outcome → status badge, mirroring the tool card's getStatusBadge tones:
// green check for proceeded, orange X for blocked (like "Denied"), red for
// error / timeout.
const OUTCOME_BADGES: Record<string, { label: string; icon: ReactNode }> = {
  proceeded: {
    label: "Proceeded",
    icon: <CheckCircleIcon className="size-4 text-green-600" />,
  },
  blocked: {
    label: "Blocked",
    icon: <XCircleIcon className="size-4 text-orange-600" />,
  },
  error: {
    label: "Error",
    icon: <XCircleIcon className="size-4 text-destructive" />,
  },
  timeout: {
    label: "Timeout",
    icon: <ClockIcon className="size-4 text-destructive" />,
  },
};

/**
 * Model-invisible debug entry for a single hook run, rendered inline in the
 * chat thread when admin debug mode is on. Styled like the expanded tool card
 * (ai-elements/tool.tsx): a bordered collapsible card with an icon + title +
 * status badge header, and Payload / Stdout / Stderr sections in CodeBlocks.
 * The backend only delivers these parts to admins on debug-enabled
 * conversations.
 */
export function HookRunChip({
  data,
  defaultOpen = false,
}: {
  data?: HookRunChipData;
  defaultOpen?: boolean;
}) {
  if (!data) {
    return null;
  }

  const badge = OUTCOME_BADGES[data.outcome ?? ""] ?? {
    label: data.outcome ?? "Unknown",
    icon: <WebhookIcon className="size-4 text-muted-foreground" />,
  };
  const hasBodies = Boolean(data.stdout || data.stderr || data.payloadJson);
  const isFailure = data.outcome === "error" || data.outcome === "timeout";

  const detail = [
    data.fileName,
    data.exitCode != null ? `exit ${data.exitCode}` : null,
    typeof data.durationMs === "number" ? `${data.durationMs}ms` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const header = (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <WebhookIcon className="size-4 flex-none text-muted-foreground" />
      <span className="font-medium text-sm">{data.hookEventName}</span>
      {data.toolName ? (
        <span className="truncate text-muted-foreground text-sm">
          → {data.toolName}
        </span>
      ) : null}
      <Badge className="gap-1.5 rounded-full text-xs" variant="secondary">
        {badge.icon}
        {badge.label}
      </Badge>
      {detail ? (
        <span className="truncate text-muted-foreground text-xs">{detail}</span>
      ) : null}
    </div>
  );

  if (!hasBodies) {
    return (
      <div
        data-testid="hook-run-chip"
        className="not-prose mb-4 w-full rounded-md border p-3"
      >
        {header}
      </div>
    );
  }

  return (
    <Collapsible
      data-testid="hook-run-chip"
      defaultOpen={defaultOpen}
      className="not-prose mb-4 w-full rounded-md border"
    >
      <CollapsibleTrigger className="group flex w-full cursor-pointer items-center justify-between gap-4 p-3">
        {header}
        <ChevronDownIcon className="size-4 flex-none text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in">
        {data.payloadJson ? (
          <PayloadSections payloadJson={data.payloadJson} />
        ) : null}
        {data.stdout ? <HookBody label="Stdout" body={data.stdout} /> : null}
        {data.stderr ? (
          <HookBody label="Stderr" body={data.stderr} isError={isFailure} />
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * The payload, split into readable sections: the tool input and tool response
 * render as their own blocks with real line breaks (multi-line strings would
 * otherwise show as `\n` escapes inside the JSON), the remaining scalar fields
 * collapse into a key-value list. Falls back to the raw pretty-printed JSON
 * when the payload doesn't parse (e.g. capped with a truncation marker).
 */
function PayloadSections({ payloadJson }: { payloadJson: string }) {
  const payload = splitHookPayload(payloadJson);
  if (!payload) {
    return (
      <HookBody
        label="Payload"
        body={prettyPrintJson(payloadJson)}
        language="json"
      />
    );
  }
  return (
    <>
      {"toolInput" in payload ? (
        <PayloadValueBlock label="Tool input" value={payload.toolInput} />
      ) : null}
      {"toolResponse" in payload ? (
        <PayloadValueBlock label="Tool response" value={payload.toolResponse} />
      ) : null}
      {Object.keys(payload.rest).length > 0 ? (
        <PayloadFieldList fields={payload.rest} />
      ) : null}
    </>
  );
}

/**
 * One payload value as its own block. Strings render raw (real line breaks);
 * objects render one sub-block per key so a multi-line `command` inside
 * `tool_input` is readable; anything else falls back to pretty JSON.
 */
function PayloadValueBlock({
  label,
  value,
}: {
  label: string;
  value: unknown;
}) {
  if (typeof value === "string") {
    return <HookBody label={label} body={value} />;
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const entries = Object.entries(value);
    if (entries.length > 0) {
      return (
        <div className="space-y-2 p-4">
          <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            {label}
          </h4>
          {entries.map(([key, entryValue]) => (
            <div key={key} className="space-y-1">
              <div className="font-mono text-muted-foreground text-xs">
                {key}
              </div>
              <CodeBody
                body={
                  typeof entryValue === "string"
                    ? entryValue
                    : JSON.stringify(entryValue, null, 2)
                }
                language={typeof entryValue === "string" ? "text" : "json"}
              />
            </div>
          ))}
        </div>
      );
    }
  }
  return (
    <HookBody
      label={label}
      body={JSON.stringify(value, null, 2)}
      language="json"
    />
  );
}

/** The payload's scalar metadata (session_id, cwd, …) as a key-value list. */
function PayloadFieldList({ fields }: { fields: Record<string, unknown> }) {
  return (
    <div className="space-y-2 p-4">
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        Payload
      </h4>
      <div className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 rounded-md bg-muted/50 p-3 font-mono text-xs">
        {Object.entries(fields).map(([key, value]) => (
          <div key={key} className="contents">
            <span className="text-muted-foreground">{key}</span>
            <span className="break-all">
              {typeof value === "string" ? value : JSON.stringify(value)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function HookBody({
  label,
  body,
  language = "text",
  isError = false,
}: {
  label: string;
  body: string;
  language?: string;
  isError?: boolean;
}) {
  return (
    <div className="space-y-2 p-4">
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {label}
      </h4>
      <CodeBody body={body} language={language} isError={isError} />
    </div>
  );
}

function CodeBody({
  body,
  language = "text",
  isError = false,
}: {
  body: string;
  language?: string;
  isError?: boolean;
}) {
  return (
    <div
      className={cn(
        "overflow-x-auto rounded-md text-xs",
        isError ? "bg-destructive/10 text-destructive" : "bg-muted/50",
      )}
    >
      <CodeBlock code={body} language={language} wrapLongLines>
        <CopyButton text={body} />
      </CodeBlock>
    </div>
  );
}

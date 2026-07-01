"use client";

import type { ToolUIPart } from "ai";
import { ChevronDownIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { createContext, useContext, useRef, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { CodeBlock } from "./code-block";

export type ToolProps = ComponentProps<typeof Collapsible>;

const ToolContext = createContext<{ hasOpened: boolean }>({ hasOpened: false });

export const Tool = ({
  className,
  onOpenChange,
  open,
  children,
  ...props
}: ToolProps) => {
  const [hasOpened, setHasOpened] = useState<boolean>(
    open ?? Boolean((props as Record<string, unknown>).defaultOpen) ?? true,
  );

  const handleOpenChange = (open: boolean) => {
    if (open) setHasOpened(true);
    onOpenChange?.(open);
  };

  return (
    <ToolContext.Provider value={{ hasOpened: hasOpened || !!open }}>
      <Collapsible
        defaultOpen={false}
        open={open}
        className={cn(
          "not-prose mb-4 w-full overflow-hidden rounded-lg border border-border/60 bg-card shadow-sm",
          className,
        )}
        onOpenChange={handleOpenChange}
        {...props}
      >
        {children}
      </Collapsible>
    </ToolContext.Provider>
  );
};

export type ToolHeaderProps = {
  title?: string;
  type: ToolUIPart["type"];
  state: ToolUIPart["state"] | "output-available-dual-llm" | "output-denied";
  className?: string;
  icon?: React.ReactNode;
  isCollapsible?: boolean;
  /** Optional action button to display in the header (e.g., View Logs) */
  actionButton?: React.ReactNode;
};

const getStatusBadge = (
  status: ToolUIPart["state"] | "output-available-dual-llm" | "output-denied",
) => {
  const labels = {
    "input-streaming": "Pending",
    "input-available": "Running",
    "approval-requested": "Approval requested",
    "approval-responded": "Approval responded",
    "output-available": "Completed",
    "output-available-dual-llm": "Completed (dual LLM)",
    "output-error": "Error",
    "output-denied": "Denied",
  } as const;

  const dotClass = {
    "input-streaming": "bg-muted-foreground/50",
    "input-available": "bg-blue-500 animate-pulse",
    "approval-requested": "bg-amber-500",
    "approval-responded": "bg-blue-500",
    "output-available": "bg-emerald-500",
    "output-available-dual-llm": "bg-emerald-500",
    "output-error": "bg-destructive",
    "output-denied": "bg-orange-500",
  } as const;

  return (
    <div className="flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground">
      <span className={cn("size-1.5 rounded-full", dotClass[status])} />
      {labels[status]}
    </div>
  );
};

export const ToolHeader = ({
  className,
  title,
  type,
  state,
  icon,
  isCollapsible = true,
  actionButton,
  ...props
}: ToolHeaderProps) => (
  <CollapsibleTrigger
    className={cn(
      "group flex w-full items-center justify-between gap-3 border-b border-border/60 bg-muted/40 px-3 py-2 cursor-pointer",
      isCollapsible ? "cursor-pointer" : "!cursor-default",
      className,
    )}
    {...props}
  >
    <div className="flex min-w-0 flex-1 items-center gap-2">
      {icon}
      <span className="truncate font-mono text-xs font-medium text-foreground">
        {title ?? type.split("-").slice(1).join("-")}
      </span>
    </div>
    <div className="flex items-center gap-3">
      {getStatusBadge(state)}
      {actionButton && (
        // biome-ignore lint/a11y/noStaticElementInteractions: Wrapper needs to stop event propagation
        <div
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {actionButton}
        </div>
      )}
      {isCollapsible && (
        <ChevronDownIcon className="size-3.5 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
      )}
    </div>
  </CollapsibleTrigger>
);

export type ToolContentProps = Omit<
  ComponentProps<typeof CollapsibleContent>,
  "forceMount"
> & {
  /** Keep children mounted even when closed (useful for MCP apps that need to preserve iframe state) */
  forceMount?: boolean;
};

export const ToolContent = ({
  className,
  children,
  forceMount = false,
  ...props
}: ToolContentProps) => {
  const { hasOpened } = useContext(ToolContext);

  const resolvedClassName = cn(
    "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
    forceMount &&
      "overflow-hidden data-[state=closed]:max-h-0 data-[state=open]:max-h-[5000px]",
    className,
  );

  if (forceMount) {
    return (
      <CollapsibleContent className={resolvedClassName} forceMount {...props}>
        {children}
      </CollapsibleContent>
    );
  }

  return (
    <CollapsibleContent className={resolvedClassName} {...props}>
      {hasOpened ? children : null}
    </CollapsibleContent>
  );
};

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolUIPart["input"];
  /** Deprecated — parameters are always rendered expanded. */
  defaultOpen?: boolean;
};

export const ToolInput = ({
  className,
  input,
  defaultOpen: _defaultOpen,
  ...props
}: ToolInputProps) => {
  return (
    <div
      className={cn("overflow-hidden p-3 space-y-1.5", className)}
      {...props}
    >
      <SectionLabel accent="bg-sky-400">Request</SectionLabel>
      <ToolInputBody input={input} />
    </div>
  );
};

const SectionLabel = ({
  children,
  accent,
}: {
  children: ReactNode;
  accent: string;
}) => (
  <div className="flex items-center gap-2">
    <span className={cn("h-3 w-[3px] rounded-full", accent)} />
    <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
      {children}
    </span>
  </div>
);

/**
 * Parameters body. An object input carrying a multi-line string value (e.g.
 * run_command's `command`, file contents) renders one block per field with
 * real line breaks instead of `\n` escapes inside a JSON dump — and the copy
 * button copies the raw value, ready to paste into a terminal. Everything
 * else keeps the compact pretty-printed JSON view.
 */
const ToolInputBody = ({ input }: { input: ToolUIPart["input"] }) => {
  const entries = getEntriesWithMultilineStrings(input);

  if (!entries) {
    const serializedInput = JSON.stringify(input, null, 2);
    return (
      <TruncatedCodeBlock
        code={serializedInput}
        language="json"
        copyText={serializedInput}
      />
    );
  }

  return (
    <div className="space-y-1.5">
      {entries.map(([key, value]) => {
        const isString = typeof value === "string";
        const code = isString ? value : JSON.stringify(value, null, 2);
        return (
          <TruncatedCodeBlock
            key={key}
            code={code}
            language={isString ? "text" : "json"}
            copyText={code}
            wrapLongLines
          />
        );
      })}
    </div>
  );
};

const COMPACT_CODE_STYLE = {
  fontSize: "0.6875rem",
  padding: "0.4rem 0.6rem",
} as const;

// Force-override the `text-sm` Tailwind class baked into CodeBlock's inner
// <code> element so the params/output text actually shrinks.
const COMPACT_CODE_CLASS =
  "[&_code]:!text-[0.6875rem] [&_code]:!leading-[1rem] [&>pre]:!text-[0.6875rem]";

const TRUNCATED_CODE_MAX_LINES = 20;

/**
 * Renders a CodeBlock that collapses long content to TRUNCATED_CODE_MAX_LINES
 * with a "Show N more lines" affordance over a gradient fade. Used for both
 * tool request bodies and tool response output so neither side overruns the
 * chat when a tool dumps a large JSON payload.
 */
const TruncatedCodeBlock = ({
  code,
  language,
  copyText,
  wrapLongLines = false,
}: {
  code: string;
  language: string;
  copyText: string;
  wrapLongLines?: boolean;
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const lines = code.split("\n");
  const isLarge = lines.length > TRUNCATED_CODE_MAX_LINES;

  const displayCode =
    isExpanded || !isLarge
      ? code
      : `${lines.slice(0, TRUNCATED_CODE_MAX_LINES).join("\n")}\n... (${
          lines.length - TRUNCATED_CODE_MAX_LINES
        } more lines)`;

  return (
    <div ref={containerRef} className="relative group">
      <CodeBlock
        code={displayCode}
        language={language}
        wrapLongLines={wrapLongLines}
        contentStyle={COMPACT_CODE_STYLE}
        contentClassName={COMPACT_CODE_CLASS}
        className="border-border/50"
      >
        <CopyButton text={copyText} className="-translate-y-1" />
      </CodeBlock>
      {isLarge && (
        <div
          className={cn(
            "absolute bottom-1 left-0 right-0 flex justify-center transition-all duration-200",
            !isExpanded &&
              "pt-12 pb-1 bg-gradient-to-t from-background/80 to-transparent",
          )}
        >
          <Button
            variant="secondary"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              const el = containerRef.current;
              const scrollTop = el ? el.getBoundingClientRect().top : undefined;
              setIsExpanded(!isExpanded);
              if (el && scrollTop !== undefined) {
                requestAnimationFrame(() => {
                  const newTop = el.getBoundingClientRect().top;
                  window.scrollBy(0, newTop - scrollTop);
                });
              }
            }}
            className="h-6 text-[10px] shadow-sm bg-background/80 backdrop-blur-sm hover:bg-background border"
          >
            {isExpanded
              ? "Show Less"
              : `Show ${lines.length - TRUNCATED_CODE_MAX_LINES} more lines`}
          </Button>
        </div>
      )}
    </div>
  );
};

export type ToolErrorDetailsProps = ComponentProps<"div"> & {
  errorText: string;
};

export const ToolErrorDetails = ({
  className,
  errorText,
  ...props
}: ToolErrorDetailsProps) => (
  <div className={cn("overflow-hidden px-3 py-2", className)} {...props}>
    <div className="rounded-md bg-destructive/10 p-3 text-destructive text-xs whitespace-pre-wrap break-words select-text">
      {errorText}
    </div>
  </div>
);

export type ToolOutputProps = ComponentProps<"div"> & {
  output?: ToolUIPart["output"];
  errorText?: ToolUIPart["errorText"];
  label?: string;
  conversations?: Array<{
    role: "user" | "assistant";
    content: string | unknown;
  }>;
};

export const ToolOutput = ({
  className,
  output,
  errorText,
  label,
  conversations,
  ...props
}: ToolOutputProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const labelText = label ?? (errorText ? "Error" : "Response");

  if (!(output || errorText || conversations)) {
    return null;
  }

  // Render conversations as chat bubbles if provided
  // Note: In Dual LLM context, "user" = Main Profile (questions), "assistant" = Quarantined Profile (answers)
  if (conversations && conversations.length > 0) {
    return (
      <div className={cn("px-3 py-3 space-y-1.5", className)} {...props}>
        <SectionLabel accent="bg-emerald-400">
          {label ?? "Conversation"}
        </SectionLabel>
        <div className="space-y-3 rounded-md bg-muted/50 p-3">
          {conversations.map((conv, idx) => {
            // Create a stable key combining index and content hash
            const contentStr =
              typeof conv.content === "string"
                ? conv.content
                : JSON.stringify(conv.content);
            const key = `${idx}-${conv.role}-${contentStr.slice(0, 20)}`;

            return (
              <div
                key={key}
                className={cn(
                  "flex gap-2 items-start",
                  conv.role === "assistant" ? "justify-end" : "justify-start",
                )}
              >
                <div
                  className={cn(
                    "max-w-[85%] rounded-lg px-3 py-2 text-xs whitespace-pre-wrap",
                    conv.role === "assistant"
                      ? "bg-primary text-primary-foreground"
                      : "bg-secondary text-secondary-foreground",
                  )}
                >
                  {contentStr}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  let Output: ReactNode;
  const displayOutput = normalizeToolOutput(output);

  if (typeof displayOutput === "object" || typeof displayOutput === "string") {
    // If output is a string, try to parse it as JSON for proper formatting
    let formattedOutput = displayOutput;
    if (typeof displayOutput === "string") {
      try {
        formattedOutput = JSON.parse(displayOutput);
      } catch {
        // Not valid JSON, use as-is
      }
    }
    const codeString =
      typeof formattedOutput === "object"
        ? JSON.stringify(formattedOutput, null, 2)
        : String(formattedOutput);

    Output = (
      <TruncatedCodeBlock
        code={codeString}
        language="json"
        copyText={codeString}
      />
    );
  } else {
    Output = <div>{String(displayOutput)}</div>;
  }

  const accent = errorText ? "bg-destructive" : "bg-emerald-400";

  return (
    <div
      ref={containerRef}
      className={cn("px-3 pb-3 pt-2 space-y-1.5", className)}
      {...props}
    >
      <SectionLabel accent={accent}>{labelText}</SectionLabel>
      <div
        className={cn(
          "overflow-x-auto rounded-md text-xs [&_table]:w-full",
          errorText ? "bg-destructive/10 text-destructive" : "text-foreground",
        )}
      >
        {Output}
      </div>
    </div>
  );
};

/**
 * Entries of a plain-object input when at least one value is a multi-line
 * string; null otherwise (caller falls back to the JSON view).
 */
function getEntriesWithMultilineStrings(
  input: unknown,
): [string, unknown][] | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const entries = Object.entries(input);
  const hasMultilineString = entries.some(
    ([, value]) => typeof value === "string" && value.includes("\n"),
  );
  return hasMultilineString ? entries : null;
}

function normalizeToolOutput(output: ToolUIPart["output"]): unknown {
  if (!isMcpToolOutput(output)) {
    return output;
  }

  if (output.content) {
    return output.content;
  }

  if (output.structuredContent !== undefined) {
    return output.structuredContent;
  }

  return output;
}

function isMcpToolOutput(value: unknown): value is {
  content: string;
  structuredContent?: unknown;
  rawContent?: unknown;
  _meta?: unknown;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "content" in value &&
    typeof value.content === "string"
  );
}

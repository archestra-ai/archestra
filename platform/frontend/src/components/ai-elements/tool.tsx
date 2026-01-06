"use client";

import type { ToolUIPart } from "ai";
import {
  CheckCircleIcon,
  ChevronDownIcon,
  CircleIcon,
  ClockIcon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { createContext, useContext, useState } from "react";
import { Badge } from "@/components/ui/badge";
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
  children,
  ...props
}: ToolProps) => {
  const [hasOpened, setHasOpened] = useState(
    props.defaultOpen || props.open || false,
  );

  const handleOpenChange = (open: boolean) => {
    if (open) setHasOpened(true);
    onOpenChange?.(open);
  };

  return (
    <ToolContext.Provider value={{ hasOpened }}>
      <Collapsible
        defaultOpen={false}
        className={cn("not-prose mb-4 w-full rounded-md border", className)}
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
  errorText?: ToolUIPart["errorText"];
  isCollapsible?: boolean;
};

const getStatusBadge = (
  status: ToolUIPart["state"] | "output-available-dual-llm" | "output-denied",
) => {
  const labels = {
    "input-streaming": "Pending",
    "input-available": "Running",
    "approval-requested": "Approval Requested",
    "approval-responded": "Approval Responded",
    "output-available": "Completed",
    "output-available-dual-llm": "Completed with dual LLM",
    "output-error": "Error",
    "output-denied": "Denied",
  } as const;

  const icons = {
    "input-streaming": <CircleIcon className="size-4" />,
    "input-available": <ClockIcon className="size-4 animate-pulse" />,
    "approval-requested": <ClockIcon className="size-4 text-yellow-600" />,
    "approval-responded": <CheckCircleIcon className="size-4 text-blue-600" />,
    "output-available": <CheckCircleIcon className="size-4 text-green-600" />,
    "output-available-dual-llm": (
      <CheckCircleIcon className="size-4 text-green-600" />
    ),
    "output-error": <XCircleIcon className="size-4 text-destructive" />,
    "output-denied": <XCircleIcon className="size-4 text-orange-600" />,
  } as const;

  return (
    <Badge className="gap-1.5 rounded-full text-xs" variant="secondary">
      {icons[status]}
      {labels[status]}
    </Badge>
  );
};

export const ToolHeader = ({
  className,
  title,
  type,
  state,
  errorText,
  icon,
  isCollapsible = true,
  ...props
}: ToolHeaderProps) => (
  <CollapsibleTrigger
    className={cn(
      "flex w-full items-center justify-between gap-4 p-3 cursor-pointer group",
      isCollapsible ? "cursor-pointer" : "!cursor-default",
      className,
    )}
    {...props}
  >
    <div>
      <div className="flex items-center gap-2">
        {icon ?? <WrenchIcon className={`size-4 text-muted-foreground`} />}
        <span className="font-medium text-sm">
          {title ?? type.split("-").slice(1).join("-")}
        </span>
        {getStatusBadge(state)}
      </div>
      {errorText && (
        // biome-ignore lint/a11y/useSemanticElements: We need text selection within the button trigger
        <div
          className="text-destructive text-xs mt-2 text-left select-text"
          style={{
            userSelect: "text",
            WebkitUserSelect: "text",
            pointerEvents: "auto",
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          role="button"
          tabIndex={-1}
        >
          {errorText}
        </div>
      )}
    </div>
    {isCollapsible && (
      <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
    )}
  </CollapsibleTrigger>
);

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({
  className,
  children,
  ...props
}: ToolContentProps) => {
  const { hasOpened } = useContext(ToolContext);

  return (
    <CollapsibleContent
      className={cn(
        "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
        className,
      )}
      {...props}
    >
      {hasOpened ? children : null}
    </CollapsibleContent>
  );
};

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolUIPart["input"];
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <div className={cn("space-y-2 overflow-hidden p-4", className)} {...props}>
    <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
      Parameters
    </h4>
    <div className="rounded-md bg-muted/50">
      <CodeBlock code={JSON.stringify(input, null, 2)} language="json" />
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
  const [isExpanded, setIsExpanded] = useState(false);

  if (!(output || errorText || conversations)) {
    return null;
  }

  // Render conversations as chat bubbles if provided
  // Note: In Dual LLM context, "user" = Main Profile (questions), "assistant" = Quarantined Profile (answers)
  if (conversations && conversations.length > 0) {
    return (
      <div className={cn("space-y-2 p-4", className)} {...props}>
        <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          {label ?? "Conversation"}
        </h4>
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

  let Output = <div>{output as ReactNode}</div>;

  if (typeof output === "object" || typeof output === "string") {
    // If output is a string, try to parse it as JSON for proper formatting
    let formattedOutput = output;
    if (typeof output === "string") {
      try {
        formattedOutput = JSON.parse(output);
      } catch {
        // Not valid JSON, use as-is
      }
    }
    const codeString =
      typeof formattedOutput === "object"
        ? JSON.stringify(formattedOutput, null, 2)
        : String(formattedOutput);
    const lines = codeString.split("\n");
    const MAX_LINES = 50;
    const isLarge = lines.length > MAX_LINES;

    const displayCode =
      isExpanded || !isLarge
        ? codeString
        : `${lines.slice(0, MAX_LINES).join("\n")}\n... (${
            lines.length - MAX_LINES
          } more lines)`;

    Output = (
      <div className="relative group">
        <CodeBlock code={displayCode} language="json" />
        {isLarge && (
          <div
            className={cn(
              "absolute bottom-4 left-0 right-0 flex justify-center transition-all duration-200",
              !isExpanded &&
                "pt-16 pb-2 bg-gradient-to-t from-background/80 to-transparent",
            )}
          >
            <Button
              variant="secondary"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                setIsExpanded(!isExpanded);
              }}
              className="h-7 text-xs shadow-sm bg-background/80 backdrop-blur-sm hover:bg-background border"
            >
              {isExpanded
                ? "Show Less"
                : `Show ${lines.length - MAX_LINES} more lines`}
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={cn("space-y-2 p-4", className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {label ?? (errorText ? "Error" : "Result")}
      </h4>
      <div
        className={cn(
          "overflow-x-auto rounded-md text-xs [&_table]:w-full",
          errorText
            ? "bg-destructive/10 text-destructive"
            : "bg-muted/50 text-foreground",
        )}
      >
        {Output}
      </div>
    </div>
  );
};

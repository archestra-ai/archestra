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
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { CodeBlock } from "./code-block";

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    defaultOpen
    className={cn("not-prose mb-4 w-full rounded-md border", className)}
    {...props}
  />
);

export type ToolHeaderProps = {
  title?: string;
  type: ToolUIPart["type"];
  state: ToolUIPart["state"] | "output-available-dual-llm";
  className?: string;
  icon?: React.ReactNode;
};

const getStatusBadge = (
  status: ToolUIPart["state"] | "output-available-dual-llm",
) => {
  const labels = {
    "input-streaming": "Pending",
    "input-available": "Running",
    "output-available": "Completed",
    "output-available-dual-llm": "Completed With Dual LLM",
    "output-error": "Error",
  } as const;

  const icons = {
    "input-streaming": <CircleIcon className="size-4" />,
    "input-available": <ClockIcon className="size-4 animate-pulse" />,
    "output-available": <CheckCircleIcon className="size-4 text-green-600" />,
    "output-available-dual-llm": (
      <CheckCircleIcon className="size-4 text-green-600" />
    ),
    "output-error": <XCircleIcon className="size-4 text-red-600" />,
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
  icon,
  ...props
}: ToolHeaderProps) => (
  <CollapsibleTrigger
    className={cn(
      "flex w-full items-center justify-between gap-4 p-3 cursor-pointer group",
      className,
    )}
    {...props}
  >
    <div className="flex items-center gap-2">
      {icon ?? <WrenchIcon className={`size-4 text-muted-foreground`} />}
      <span className="font-medium text-sm">
        {title ?? type.split("-").slice(1).join("-")}
      </span>
      {getStatusBadge(state)}
    </div>
    <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
  </CollapsibleTrigger>
);

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
      className,
    )}
    {...props}
  />
);

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
  if (!(output || errorText || conversations)) {
    return null;
  }

  // Render conversations as chat bubbles if provided
  // Note: In Dual LLM context, "user" = Main Agent (questions), "assistant" = Quarantined Agent (answers)
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
                      : "bg-secondary text-foreground",
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

  if (typeof output === "object") {
    Output = (
      <CodeBlock code={JSON.stringify(output, null, 2)} language="json" />
    );
  } else if (typeof output === "string") {
    Output = <CodeBlock code={output} language="json" />;
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
        {errorText && <div>{errorText}</div>}
        {Output}
      </div>
    </div>
  );
};

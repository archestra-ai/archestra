"use client";

import type { ToolUIPart } from "ai";
import type { ComponentProps, ReactNode } from "react";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CodeBlock } from "@/components/ai-elements/code-block";
import { normalizeToolOutput } from "./tool-output.utils";
import { useExpandableCodeBlock } from "./use-expandable-code-block";

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
  const labelText = label ?? (errorText ? "Error" : "Result");

  if (!(output || errorText || conversations)) {
    return null;
  }

  if (conversations && conversations.length > 0) {
    return (
      <ToolConversationOutput
        className={className}
        conversations={conversations}
        label={label}
        {...props}
      />
    );
  }

  const displayOutput = normalizeToolOutput(output);
  const renderedOutput = formatToolOutput(displayOutput);

  return (
    <ToolOutputContainer
      className={className}
      errorText={errorText}
      labelText={labelText}
      renderedOutput={renderedOutput}
      {...props}
    />
  );
};

function ToolConversationOutput({
  className,
  conversations,
  label,
  ...props
}: ComponentProps<"div"> & {
  conversations: NonNullable<ToolOutputProps["conversations"]>;
  label?: string;
}) {
  return (
    <div className={cn("space-y-2 p-4", className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {label ?? "Conversation"}
      </h4>
      <div className="space-y-3 rounded-md bg-muted/50 p-3">
        {conversations.map((conv, idx) => {
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

function ToolOutputContainer({
  className,
  errorText,
  labelText,
  renderedOutput,
  ...props
}: ComponentProps<"div"> & {
  errorText?: ToolUIPart["errorText"];
  labelText: string;
  renderedOutput: FormattedToolOutput;
}) {
  const code =
    renderedOutput.kind === "code" ? renderedOutput.codeString : undefined;
  const expandable = useExpandableCodeBlock(code ?? "");
  const outputNode =
    renderedOutput.kind === "node" ? (
      renderedOutput.node
    ) : (
      <ExpandableCodeOutput
        code={renderedOutput.codeString}
        expandable={expandable}
      />
    );

  return (
    <div
      ref={expandable.containerRef}
      className={cn("space-y-2 p-4", className)}
      {...props}
    >
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {labelText}
      </h4>
      <div
        className={cn(
          "overflow-x-auto rounded-md text-xs [&_table]:w-full",
          errorText
            ? "bg-destructive/10 text-destructive"
            : "bg-muted/50 text-foreground",
        )}
      >
        {outputNode}
      </div>
    </div>
  );
}

function ExpandableCodeOutput({
  code,
  expandable,
}: {
  code: string;
  expandable: ReturnType<typeof useExpandableCodeBlock>;
}) {
  return (
    <div className="relative group">
      <CodeBlock code={expandable.displayCode} language="json">
        <CopyButton text={code} />
      </CodeBlock>
      {expandable.isLarge && (
        <div
          className={cn(
            "absolute bottom-4 left-0 right-0 flex justify-center transition-all duration-200",
            !expandable.isExpanded &&
              "pt-16 pb-2 bg-gradient-to-t from-background/80 to-transparent",
          )}
        >
          <Button
            variant="secondary"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              expandable.toggleExpanded();
            }}
            className="h-7 text-xs shadow-sm bg-background/80 backdrop-blur-sm hover:bg-background border"
          >
            {expandable.isExpanded
              ? "Show Less"
              : `Show ${expandable.remainingLines} more lines`}
          </Button>
        </div>
      )}
    </div>
  );
}

type FormattedToolOutput =
  | { kind: "code"; codeString: string }
  | { kind: "node"; node: ReactNode };

function formatToolOutput(displayOutput: unknown): FormattedToolOutput {
  if (typeof displayOutput === "object" || typeof displayOutput === "string") {
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

    return {
      kind: "code",
      codeString,
    };
  }

  return {
    kind: "node",
    node: <div>{String(displayOutput)}</div>,
  };
}

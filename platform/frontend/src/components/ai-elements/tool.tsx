import { ChevronDown, ChevronRight, Play, MessageSquare } from "lucide-react";
import { type ReactNode, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function Tool({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div
      className={cn(
        "rounded-lg border bg-muted/50 overflow-hidden",
        className,
      )}
      onClick={() => {
        if (className?.includes("cursor-pointer")) {
          setIsOpen(!isOpen);
        }
      }}
      onKeyDown={(e) => {
        if (
          className?.includes("cursor-pointer") &&
          (e.key === "Enter" || e.key === " ")
        ) {
          e.preventDefault();
          setIsOpen(!isOpen);
        }
      }}
    >
      <ToolContext.Provider value={{ isOpen, setIsOpen }}>
        {children}
      </ToolContext.Provider>
    </div>
  );
}

const ToolContext = React.createContext<{
  isOpen: boolean;
  setIsOpen: (isOpen: boolean) => void;
}>({
  isOpen: false,
  setIsOpen: () => {},
});

import React from "react";

export function ToolHeader({
  type,
  state,
  errorText,
  isCollapsible = true,
}: {
  type: string;
  state: "input-available" | "output-available" | "output-error";
  errorText?: string;
  isCollapsible?: boolean;
}) {
  const { isOpen, setIsOpen } = React.useContext(ToolContext);

  const displayName = type.replace(/^tool-/, "").replace(/__/g, " › ");

  const stateConfig = {
    "input-available": {
      icon: "⏳",
      label: "Running",
      color: "text-yellow-600 dark:text-yellow-400",
    },
    "output-available": {
      icon: "✓",
      label: "Complete",
      color: "text-green-600 dark:text-green-400",
    },
    "output-error": {
      icon: "✗",
      label: "Error",
      color: "text-red-600 dark:text-red-400",
    },
  };

  const config = stateConfig[state];

  return (
    <div
      className={cn(
        "flex items-center gap-2 px-3 py-2 text-sm font-medium",
        isCollapsible && "cursor-pointer hover:bg-muted/70",
      )}
      onClick={(e) => {
        if (isCollapsible) {
          e.stopPropagation();
          setIsOpen(!isOpen);
        }
      }}
      onKeyDown={(e) => {
        if (isCollapsible && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          e.stopPropagation();
          setIsOpen(!isOpen);
        }
      }}
    >
      {isCollapsible &&
        (isOpen ? (
          <ChevronDown className="h-4 w-4 flex-shrink-0" />
        ) : (
          <ChevronRight className="h-4 w-4 flex-shrink-0" />
        ))}
      <span className={cn("flex-shrink-0", config.color)}>{config.icon}</span>
      <span className="font-mono text-xs truncate">{displayName}</span>
      <span className={cn("text-xs ml-auto flex-shrink-0", config.color)}>
        {errorText ? "Error" : config.label}
      </span>
    </div>
  );
}

export function ToolContent({ children }: { children: ReactNode }) {
  const { isOpen } = React.useContext(ToolContext);

  if (!isOpen) return null;

  return <div className="border-t">{children}</div>;
}

export function ToolInput({ input }: { input: Record<string, unknown> }) {
  return (
    <div className="px-3 py-2 space-y-1">
      <div className="text-xs font-semibold text-muted-foreground mb-1">
        Input
      </div>
      <pre className="text-xs bg-background/50 rounded p-2 overflow-x-auto">
        {JSON.stringify(input, null, 2)}
      </pre>
    </div>
  );
}

export function ToolOutput({
  label = "Result",
  output,
  errorText,
  onRunTool,
  onUseAsPrompt,
}: {
  label?: string;
  output: unknown;
  errorText?: string;
  onRunTool?: () => void;
  onUseAsPrompt?: () => void;
}) {
  const outputText =
    typeof output === "string" ? output : JSON.stringify(output, null, 2);

  return (
    <div className="px-3 py-2 space-y-1">
      <div className="flex items-center justify-between mb-1">
        <div className="text-xs font-semibold text-muted-foreground">
          {label}
        </div>
        {!errorText && (onRunTool || onUseAsPrompt) && (
          <div className="flex items-center gap-1">
            <TooltipProvider>
              {onRunTool && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRunTool();
                      }}
                    >
                      <Play className="h-3 w-3 mr-1" />
                      Run Tool
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>Execute this tool again with the same parameters</p>
                  </TooltipContent>
                </Tooltip>
              )}
              {onUseAsPrompt && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      onClick={(e) => {
                        e.stopPropagation();
                        onUseAsPrompt();
                      }}
                    >
                      <MessageSquare className="h-3 w-3 mr-1" />
                      Use as Prompt
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>Copy this output to the chat input</p>
                  </TooltipContent>
                </Tooltip>
              )}
            </TooltipProvider>
          </div>
        )}
      </div>
      <pre
        className={cn(
          "text-xs rounded p-2 overflow-x-auto select-text",
          errorText
            ? "bg-red-50 dark:bg-red-950/20 text-red-900 dark:text-red-200"
            : "bg-background/50",
        )}
      >
        {outputText}
      </pre>
    </div>
  );
}
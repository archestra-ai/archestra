"use client";

import { ArrowDown } from "lucide-react";
import {
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { LogConsole } from "@/components/log-console";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type DeploymentConsoleTab = {
  value: string;
  label: string;
  disabled?: boolean;
  disabledReason?: string;
  testId?: string;
};

/** Shared follow-tail behavior for deployment log consoles. */
export function useDeploymentLogAutoScroll() {
  const [isAtBottom, setIsAtBottom] = useState(true);
  const isAtBottomRef = useRef(true);
  const scrollAreaRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const scrollContainer = getScrollViewport(scrollAreaRef.current);
    if (!scrollContainer) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
      const nextIsAtBottom = scrollTop + clientHeight >= scrollHeight - 10;
      isAtBottomRef.current = nextIsAtBottom;
      setIsAtBottom(nextIsAtBottom);
    };

    scrollContainer.addEventListener("scroll", handleScroll);
    return () => scrollContainer.removeEventListener("scroll", handleScroll);
  }, []);

  const scrollToBottom = useCallback(() => {
    const scrollContainer = getScrollViewport(scrollAreaRef.current);
    if (!scrollContainer) return;
    scrollContainer.scrollTop = scrollContainer.scrollHeight;
    isAtBottomRef.current = true;
    setIsAtBottom(true);
  }, []);

  const followNewOutput = useCallback(() => {
    if (!isAtBottomRef.current) return;
    setTimeout(scrollToBottom, 10);
  }, [scrollToBottom]);

  const reset = useCallback(() => {
    isAtBottomRef.current = true;
    setIsAtBottom(true);
  }, []);

  return {
    scrollAreaRef,
    showScrollToBottom: !isAtBottom,
    scrollToBottom,
    followNewOutput,
    reset,
  };
}

/**
 * Shared tab chrome for a deployed workload's logs and interactive tools.
 * MCP deployments and Agent background executions use the same visual and
 * interaction pattern even though their WebSocket transports differ.
 */
export function DeploymentConsoleTabs({
  value,
  onValueChange,
  tabs,
  hideTabBar = false,
  variant = "segmented",
  children,
  className,
}: {
  value: string;
  onValueChange: (value: string) => void;
  tabs: DeploymentConsoleTab[];
  hideTabBar?: boolean;
  variant?: "segmented" | "underline";
  children: ReactNode;
  className?: string;
}) {
  return (
    <Tabs
      value={value}
      onValueChange={onValueChange}
      className={cn("flex min-h-0 flex-1 flex-col", className)}
    >
      {!hideTabBar && (
        <TabsList
          className={cn(
            "h-9 w-fit flex-shrink-0",
            variant === "segmented"
              ? "border bg-slate-100 p-1 dark:bg-slate-800"
              : "gap-1 rounded-none border-0 bg-transparent p-0",
          )}
        >
          {tabs.map((tab) => {
            const trigger = (
              <TabsTrigger
                key={tab.value}
                value={tab.value}
                disabled={tab.disabled}
                className={cn(
                  variant === "segmented"
                    ? "px-6"
                    : "h-9 rounded-none border-x-0 border-b-2 border-t-0 border-transparent bg-transparent px-3 shadow-none data-[state=active]:border-b-foreground data-[state=active]:bg-transparent data-[state=active]:shadow-none dark:data-[state=active]:border-b-foreground dark:data-[state=active]:bg-transparent",
                )}
                data-testid={tab.testId}
              >
                {tab.label}
              </TabsTrigger>
            );
            if (!tab.disabled || !tab.disabledReason) return trigger;
            return (
              <Tooltip key={tab.value}>
                <TooltipTrigger asChild>
                  <span>{trigger}</span>
                </TooltipTrigger>
                <TooltipContent>{tab.disabledReason}</TooltipContent>
              </Tooltip>
            );
          })}
        </TabsList>
      )}
      {children}
    </Tabs>
  );
}

/** Shared deployment-log surface used by MCP servers and Agent executions. */
export function DeploymentLogPanel({
  title,
  detail,
  content,
  error,
  placeholder,
  emptyMessage,
  status,
  scrollAreaRef,
  showScrollToBottom = false,
  onScrollToBottom,
  actions,
  className,
  contentTestId,
  errorTestId,
}: {
  title: string;
  detail?: string | null;
  content: string | null | undefined;
  error?: string | null;
  placeholder?: ReactNode;
  emptyMessage?: string;
  status?: ReactNode;
  scrollAreaRef?: Ref<HTMLDivElement>;
  showScrollToBottom?: boolean;
  onScrollToBottom?: () => void;
  actions?: ReactNode;
  className?: string;
  contentTestId?: string;
  errorTestId?: string;
}) {
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col gap-2", className)}>
      <div className="flex flex-shrink-0 items-center justify-between gap-3">
        <h3 className="min-w-0 truncate text-sm font-semibold">
          {title}
          {detail && (
            <span className="font-normal text-muted-foreground">
              {" "}
              for {detail}
            </span>
          )}
        </h3>
        <div className="flex items-center gap-2">
          {showScrollToBottom && onScrollToBottom && (
            <Button
              variant="outline"
              size="sm"
              onClick={onScrollToBottom}
              className="border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100"
            >
              <ArrowDown className="mr-2 h-3 w-3" />
              Scroll to Bottom
            </Button>
          )}
          {actions}
        </div>
      </div>
      <LogConsole
        className="flex-1"
        scrollAreaRef={scrollAreaRef}
        content={content}
        error={error}
        placeholder={placeholder}
        emptyMessage={emptyMessage}
        status={status}
        contentTestId={contentTestId}
        errorTestId={errorTestId}
      />
    </div>
  );
}

function getScrollViewport(root: HTMLDivElement | null): HTMLElement | null {
  return root?.querySelector("[data-radix-scroll-area-viewport]") ?? null;
}

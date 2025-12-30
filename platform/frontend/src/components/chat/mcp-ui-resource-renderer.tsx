"use client";


import type { UIActionResult, UIResourceContent } from "@shared";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

interface UIResourceRendererComponentProps {
  resource: UIResourceContent;
  onUIAction?: (action: UIActionResult) => Promise<unknown>;
  htmlProps?: {
    style?: React.CSSProperties;
    autoResizeIframe?: boolean | { width?: boolean; height?: boolean };
    iframeRenderData?: Record<string, unknown>;
  };
}

let LazyUIResourceRenderer: React.ComponentType<UIResourceRendererComponentProps> | null =
  null;

interface McpUIResourceRendererProps {
  resource: UIResourceContent;
  onToolCall?: (toolName: string, params: Record<string, unknown>) => void;
  onPromptSubmit?: (prompt: string) => void;
  onIntent?: (intent: string, params: Record<string, unknown>) => void;
  className?: string;
  iframeRenderData?: Record<string, unknown>;
  maxRetries?: number;
}

export function McpUIResourceRenderer({
  resource,
  onToolCall,
  onPromptSubmit,
  onIntent,
  className,
  iframeRenderData,
  maxRetries = 3,
}: McpUIResourceRendererProps) {
  const [isLoaded, setIsLoaded] = useState(!!LazyUIResourceRenderer);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    if (LazyUIResourceRenderer || (loadError && retryCount === 0)) return;

    import("@mcp-ui/client")
      .then((mod) => {
        LazyUIResourceRenderer = mod.UIResourceRenderer;
        setIsLoaded(true);
        setLoadError(null);
      })
      .catch((err) => {
        setLoadError(err.message);
      });
  }, [retryCount, loadError]);

  const handleUIAction = useCallback(
    async (action: UIActionResult): Promise<{ status: string }> => {
      switch (action.type) {
        case "tool":
          onToolCall?.(action.payload.toolName, action.payload.params);
          return { status: "handled" };

        case "prompt":
          onPromptSubmit?.(action.payload.prompt);
          return { status: "handled" };

        case "link":
          window.open(action.payload.url, "_blank", "noopener,noreferrer");
          return { status: "handled" };

        case "notify":
          toast.info(action.payload.message);
          return { status: "handled" };

        case "intent":
          onIntent?.(action.payload.intent, action.payload.params);
          return { status: "handled" };

        default:
          return { status: "unhandled" };
      }
    },
    [onToolCall, onPromptSubmit, onIntent],
  );

  const handleRetry = () => {
    setRetryCount((prev) => prev + 1);
  };

  if (loadError) {
    return (
      <div className="p-4 border border-destructive/50 rounded-md bg-destructive/10">
        <p className="text-sm text-destructive">
          Failed to load UI component: {loadError}
        </p>
        {retryCount < maxRetries && (
          <button
            type="button"
            onClick={handleRetry}
            className="mt-2 px-3 py-1 text-sm bg-primary text-primary-foreground rounded hover:opacity-90 transition-opacity"
          >
            Retry ({maxRetries - retryCount} attempts left)
          </button>
        )}
      </div>
    );
  }

  if (!isLoaded || !LazyUIResourceRenderer) {
    return (
      <div
        className="p-4 border rounded-md animate-pulse bg-muted"
        data-testid="loading-skeleton"
      >
        <div className="h-32 bg-muted-foreground/20 rounded" />
      </div>
    );
  }

  return (
    <div
      className={`${className || ""} bg-background rounded-lg border border-border`}
    >
      <LazyUIResourceRenderer
        resource={resource}
        onUIAction={handleUIAction}
        htmlProps={{
          style: {
            width: "100%",
            minHeight: "200px",
            border: "none",
            borderRadius: "8px",
            boxShadow: "0 0 0 1px hsl(var(--border)) inset",
            backgroundColor: "hsl(var(--background))",
            color: "hsl(var(--foreground))",
          },
          autoResizeIframe: { height: true },
          iframeRenderData,
        }}
      />
    </div>
  );
}

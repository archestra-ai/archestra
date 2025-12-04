"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface UIResource {
  uri: string;
  mimeType: "text/html" | "text/uri-list" | "application/vnd.mcp-ui.remote-dom";
  text?: string;
  blob?: string;
  _meta?: {
    "mcpui.dev/ui-preferred-frame-size"?: { width: number; height: number };
  };
}

interface McpUiMessage {
  type: string;
  messageId?: string;
  payload?: unknown;
  _nonce?: string;
}

interface McpUiWrapperProps {
  resource: UIResource;
  onToolCall?: (toolName: string, params: Record<string, unknown>) => Promise<unknown>;
  onPrompt?: (promptName: string, params: Record<string, unknown>) => Promise<unknown>;
  onIntent?: (intent: string, params: Record<string, unknown>) => void;
  className?: string;
}

function generateNonce(): string {
  return `mcp-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
}

export function McpUiWrapper({
  resource,
  onToolCall,
  onPrompt,
  onIntent,
  className,
}: McpUiWrapperProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [iframeHeight, setIframeHeight] = useState(300);
  const [iframeWidth, setIframeWidth] = useState<number | undefined>(undefined);
  const [isReady, setIsReady] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  
  const sessionNonce = useMemo(() => generateNonce(), []);

  const preferredSize = resource._meta?.["mcpui.dev/ui-preferred-frame-size"];
  const initialHeight = preferredSize?.height ?? 300;
  const initialWidth = preferredSize?.width;

  useEffect(() => {
    setIframeHeight(initialHeight);
    if (initialWidth) setIframeWidth(initialWidth);
  }, [initialHeight, initialWidth]);

  const getTargetOrigin = useCallback((): string => {
    if (resource.mimeType === "text/uri-list" && resource.text?.trim()) {
      try {
        return new URL(resource.text.trim()).origin;
      } catch {
        return "*";
      }
    }
    return "*";
  }, [resource]);

  const sendMessageToIframe = useCallback(
    (message: McpUiMessage) => {
      if (iframeRef.current?.contentWindow) {
        const targetOrigin = getTargetOrigin();
        iframeRef.current.contentWindow.postMessage(message, targetOrigin);
      }
    },
    [getTargetOrigin]
  );

  const handleIframeMessage = useCallback(
    async (event: MessageEvent) => {
      if (!iframeRef.current) return;
      if (event.source !== iframeRef.current.contentWindow) return;
      
      if (resource.mimeType === "text/uri-list") {
        const resourceUrl = resource.text?.trim();
        if (resourceUrl) {
          try {
            const expectedOrigin = new URL(resourceUrl).origin;
            if (event.origin !== expectedOrigin && event.origin !== "null") {
              console.warn("MCP UI: Ignoring message from unexpected origin", event.origin);
              return;
            }
          } catch {
          }
        }
      } else if (resource.mimeType === "text/html") {
        if (event.origin !== "null") {
          console.warn("MCP UI: Ignoring message from unexpected origin for blob URL", event.origin);
          return;
        }
      }

      const data = event.data as McpUiMessage;
      if (!data || typeof data !== "object") return;
      
      if (resource.mimeType === "text/html" && data._nonce !== sessionNonce) {
        if (data.type !== "ui-lifecycle-iframe-ready") {
          console.warn("MCP UI: Ignoring message with invalid nonce");
          return;
        }
      }

      switch (data.type) {
        case "ui-lifecycle-iframe-ready":
          setIsReady(true);
          setIsAuthenticated(true);
          sendMessageToIframe({
            type: "ui-lifecycle-iframe-authenticated",
            payload: { nonce: sessionNonce },
          });
          break;

        case "ui-size-change": {
          const sizePayload = data.payload as { width?: number; height?: number } | undefined;
          if (sizePayload?.height) setIframeHeight(sizePayload.height);
          if (sizePayload?.width) setIframeWidth(sizePayload.width);
          break;
        }

        case "tool": {
          const toolPayload = data.payload as { toolName: string; params?: Record<string, unknown> } | undefined;
          if (toolPayload?.toolName && onToolCall) {
            try {
              if (data.messageId) {
                sendMessageToIframe({
                  type: "ui-message-received",
                  messageId: data.messageId,
                });
              }
              const result = await onToolCall(toolPayload.toolName, toolPayload.params ?? {});
              if (data.messageId) {
                sendMessageToIframe({
                  type: "ui-message-response",
                  messageId: data.messageId,
                  payload: { response: result },
                });
              }
            } catch (error) {
              if (data.messageId) {
                sendMessageToIframe({
                  type: "ui-message-response",
                  messageId: data.messageId,
                  payload: { error: { message: error instanceof Error ? error.message : "Unknown error" } },
                });
              }
            }
          }
          break;
        }

        case "prompt": {
          const promptPayload = data.payload as { promptName: string; params?: Record<string, unknown> } | undefined;
          if (promptPayload?.promptName && onPrompt) {
            try {
              if (data.messageId) {
                sendMessageToIframe({
                  type: "ui-message-received",
                  messageId: data.messageId,
                });
              }
              const result = await onPrompt(promptPayload.promptName, promptPayload.params ?? {});
              if (data.messageId) {
                sendMessageToIframe({
                  type: "ui-message-response",
                  messageId: data.messageId,
                  payload: { response: result },
                });
              }
            } catch (error) {
              if (data.messageId) {
                sendMessageToIframe({
                  type: "ui-message-response",
                  messageId: data.messageId,
                  payload: { error: { message: error instanceof Error ? error.message : "Unknown error" } },
                });
              }
            }
          }
          break;
        }

        case "intent": {
          const intentPayload = data.payload as { intent: string; params?: Record<string, unknown> } | undefined;
          if (intentPayload?.intent && onIntent) {
            onIntent(intentPayload.intent, intentPayload.params ?? {});
          }
          break;
        }

        case "ui-request-data":
        case "ui-request-render-data":
          sendMessageToIframe({
            type: "ui-lifecycle-iframe-render-data",
            messageId: data.messageId,
            payload: {},
          });
          break;
      }
    },
    [onToolCall, onPrompt, onIntent, sendMessageToIframe, resource, sessionNonce]
  );

  useEffect(() => {
    window.addEventListener("message", handleIframeMessage);
    return () => window.removeEventListener("message", handleIframeMessage);
  }, [handleIframeMessage]);

  const getIframeSrc = useCallback(() => {
    switch (resource.mimeType) {
      case "text/uri-list":
        return resource.text?.trim();

      case "text/html": {
        let html = resource.text;
        if (!html && resource.blob) {
          try {
            html = atob(resource.blob);
          } catch {
            html = resource.blob;
          }
        }
        if (html) {
          const blob = new Blob([html], { type: "text/html" });
          return URL.createObjectURL(blob);
        }
        return undefined;
      }

      case "application/vnd.mcp-ui.remote-dom":
        return undefined;

      default:
        return undefined;
    }
  }, [resource]);

  const iframeSrc = getIframeSrc();

  if (resource.mimeType === "application/vnd.mcp-ui.remote-dom") {
    return (
      <div className={className}>
        <div className="text-muted-foreground text-xs p-2 bg-muted/50 rounded">
          Remote DOM rendering is not yet supported
        </div>
      </div>
    );
  }

  if (!iframeSrc) {
    return null;
  }

  return (
    <div className={className}>
      <iframe
        ref={iframeRef}
        src={iframeSrc}
        style={{
          width: iframeWidth ? `${iframeWidth}px` : "100%",
          height: `${iframeHeight}px`,
          border: "none",
          borderRadius: "8px",
          backgroundColor: "white",
        }}
        sandbox="allow-scripts allow-forms"
        title="MCP UI"
        loading="lazy"
      />
    </div>
  );
}

export function isUIResource(content: unknown): content is { type: "resource"; resource: UIResource } {
  if (!content || typeof content !== "object") return false;
  
  const obj = content as Record<string, unknown>;
  
  if (obj.type === "resource" && obj.resource && typeof obj.resource === "object") {
    const resource = obj.resource as Record<string, unknown>;
    const uri = resource.uri;
    const mimeType = resource.mimeType;
    
    if (typeof uri === "string" && uri.startsWith("ui://")) {
      return true;
    }
    
    if (
      mimeType === "text/html" ||
      mimeType === "text/uri-list" ||
      mimeType === "application/vnd.mcp-ui.remote-dom"
    ) {
      return true;
    }
  }
  
  return false;
}

export function extractUIResource(content: unknown): UIResource | null {
  if (!isUIResource(content)) return null;
  
  const obj = content as { type: "resource"; resource: UIResource };
  return obj.resource;
}

export function hasUIResourceInOutput(output: unknown, depth = 0): boolean {
  if (!output || depth > 10) return false;
  
  if (isUIResource(output)) return true;
  
  if (Array.isArray(output)) {
    return output.some((item) => hasUIResourceInOutput(item, depth + 1));
  }
  
  if (typeof output === "string") {
    try {
      const parsed = JSON.parse(output);
      return hasUIResourceInOutput(parsed, depth + 1);
    } catch {
      return false;
    }
  }
  
  if (typeof output === "object") {
    const obj = output as Record<string, unknown>;
    
    for (const key of ["content", "output", "result", "data", "entries", "resources"]) {
      if (obj[key] !== undefined) {
        if (hasUIResourceInOutput(obj[key], depth + 1)) return true;
      }
    }
    
    if (obj.type === "resource" || obj.resource) {
      if (isUIResource(obj)) return true;
    }
    
    for (const value of Object.values(obj)) {
      if (value && typeof value === "object") {
        if (hasUIResourceInOutput(value, depth + 1)) return true;
      }
    }
  }
  
  return false;
}

export function extractUIResourcesFromOutput(output: unknown, depth = 0): UIResource[] {
  const resources: UIResource[] = [];
  
  if (!output || depth > 10) return resources;
  
  if (isUIResource(output)) {
    const resource = extractUIResource(output);
    if (resource) resources.push(resource);
    return resources;
  }
  
  if (Array.isArray(output)) {
    for (const item of output) {
      resources.push(...extractUIResourcesFromOutput(item, depth + 1));
    }
    return resources;
  }
  
  if (typeof output === "string") {
    try {
      const parsed = JSON.parse(output);
      return extractUIResourcesFromOutput(parsed, depth + 1);
    } catch {
      return resources;
    }
  }
  
  if (typeof output === "object") {
    const obj = output as Record<string, unknown>;
    
    for (const key of ["content", "output", "result", "data", "entries", "resources"]) {
      if (obj[key] !== undefined) {
        resources.push(...extractUIResourcesFromOutput(obj[key], depth + 1));
      }
    }
    
    if (obj.type === "resource" && obj.resource) {
      const resource = extractUIResource(obj);
      if (resource) {
        if (!resources.some(r => r.uri === resource.uri)) {
          resources.push(resource);
        }
      }
    }
    
    for (const [key, value] of Object.entries(obj)) {
      if (!["content", "output", "result", "data", "entries", "resources", "type", "resource"].includes(key)) {
        if (value && typeof value === "object") {
          resources.push(...extractUIResourcesFromOutput(value, depth + 1));
        }
      }
    }
  }
  
  return resources;
}

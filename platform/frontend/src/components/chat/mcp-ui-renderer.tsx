"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface MCPUIMessage {
  type: string;
  messageId?: string;
  payload: Record<string, unknown>;
}

interface MCPUIRendererProps {
  resourceUri: string;
  toolName: string;
  onToolCall?: (toolName: string, params: Record<string, unknown>) => Promise<unknown>;
  onPrompt?: (prompt: string) => Promise<unknown>;
  onNavigate?: (url: string) => void;
  onError?: (error: string) => void;
}

export function MCPUIRenderer({
  resourceUri,
  toolName,
  onToolCall,
  onPrompt,
  onNavigate,
  onError,
}: MCPUIRendererProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(400);
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Handle messages from iframe
  const handleMessage = useCallback(
    async (event: MessageEvent) => {
      // Validate origin for security
      try {
        const resourceUrl = new URL(resourceUri);
        const messageOrigin = new URL(event.origin);
        // Allow same origin or trusted domains
        if (messageOrigin.hostname !== resourceUrl.hostname) {
          console.warn(`Received message from untrusted origin: ${event.origin}`);
          return;
        }
      } catch (e) {
        console.error("Failed to validate origin:", e);
        return;
      }

      const message = event.data as MCPUIMessage;

      switch (message.type) {
        case "ui-lifecycle-iframe-ready":
          setIsReady(true);
          // Send render data if needed
          if (iframeRef.current?.contentWindow) {
            iframeRef.current.contentWindow.postMessage(
              {
                type: "ui-lifecycle-iframe-render-data",
                payload: {
                  renderData: {
                    theme: "light",
                    toolName,
                  },
                },
              },
              "*"
            );
          }
          break;

        case "ui-size-change":
          if (message.payload.height) {
            setHeight(Math.max(200, Math.min(800, message.payload.height as number)));
          }
          break;

        case "intent":
          // Handle user intent (e.g., create-task)
          console.log("Intent received:", message.payload);
          // Send acknowledgment
          if (message.messageId && iframeRef.current?.contentWindow) {
            iframeRef.current.contentWindow.postMessage(
              {
                type: "ui-message-received",
                messageId: message.messageId,
              },
              "*"
            );
          }
          break;

        case "tool":
          // Execute tool call
          if (onToolCall) {
            try {
              const result = await onToolCall(
                message.payload.toolName as string,
                (message.payload.params as Record<string, unknown>) || {}
              );
              if (message.messageId && iframeRef.current?.contentWindow) {
                iframeRef.current.contentWindow.postMessage(
                  {
                    type: "ui-message-response",
                    messageId: message.messageId,
                    payload: {
                      response: result,
                    },
                  },
                  "*"
                );
              }
            } catch (err) {
              if (message.messageId && iframeRef.current?.contentWindow) {
                iframeRef.current.contentWindow.postMessage(
                  {
                    type: "ui-message-response",
                    messageId: message.messageId,
                    payload: {
                      error: err instanceof Error ? err.message : "Tool execution failed",
                    },
                  },
                  "*"
                );
              }
            }
          }
          break;

        case "prompt":
          // Run prompt through chat
          if (onPrompt) {
            try {
              const result = await onPrompt(message.payload.prompt as string);
              if (message.messageId && iframeRef.current?.contentWindow) {
                iframeRef.current.contentWindow.postMessage(
                  {
                    type: "ui-message-response",
                    messageId: message.messageId,
                    payload: {
                      response: result,
                    },
                  },
                  "*"
                );
              }
            } catch (err) {
              if (message.messageId && iframeRef.current?.contentWindow) {
                iframeRef.current.contentWindow.postMessage(
                  {
                    type: "ui-message-response",
                    messageId: message.messageId,
                    payload: {
                      error: err instanceof Error ? err.message : "Prompt execution failed",
                    },
                  },
                  "*"
                );
              }
            }
          }
          break;

        case "link":
          // Navigate to link
          if (onNavigate) {
            onNavigate(message.payload.url as string);
          }
          break;

        case "notify":
          // Handle notification
          console.log("Notification:", message.payload.message);
          break;

        case "ui-request-data":
          // Handle data request
          console.log("Data request:", message.payload);
          if (message.messageId && iframeRef.current?.contentWindow) {
            iframeRef.current.contentWindow.postMessage(
              {
                type: "ui-message-response",
                messageId: message.messageId,
                payload: {
                  response: {},
                },
              },
              "*"
            );
          }
          break;

        case "ui-request-render-data":
          // Handle render data request
          if (message.messageId && iframeRef.current?.contentWindow) {
            iframeRef.current.contentWindow.postMessage(
              {
                type: "ui-lifecycle-iframe-render-data",
                messageId: message.messageId,
                payload: {
                  renderData: {
                    theme: "light",
                    toolName,
                  },
                },
              },
              "*"
            );
          }
          break;

        default:
          console.warn("Unknown message type:", message.type);
      }
    },
    [resourceUri, toolName, onToolCall, onPrompt, onNavigate]
  );

  // Set up message listener
  useEffect(() => {
    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, [handleMessage]);

  // Handle iframe load
  const handleIframeLoad = useCallback(() => {
    console.log("MCP UI iframe loaded:", resourceUri);
  }, [resourceUri]);

  // Handle iframe error
  const handleIframeError = useCallback(() => {
    const errorMsg = `Failed to load MCP UI from ${resourceUri}`;
    setError(errorMsg);
    onError?.(errorMsg);
  }, [resourceUri, onError]);

  return (
    <div className="w-full rounded-lg border bg-muted/50 overflow-hidden">
      {error ? (
        <div className="p-4 text-sm text-destructive">
          <p className="font-medium">Failed to load interactive UI</p>
          <p className="text-xs mt-1">{error}</p>
        </div>
      ) : (
        <iframe
          ref={iframeRef}
          src={resourceUri}
          title={`MCP UI for ${toolName}`}
          style={{
            width: "100%",
            height: `${height}px`,
            border: "none",
            display: isReady ? "block" : "block",
          }}
          sandbox={{
            allowScripts: true,
            allowSameOrigin: true,
            allowPopups: false,
            allowForms: true,
          }}
          onLoad={handleIframeLoad}
          onError={handleIframeError}
        />
      )}
    </div>
  );
}

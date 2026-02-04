"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

// Define the shape of MCP UI Metadata based on the issue description
// "Key Fields: _meta and uiMetadata blocks"
export interface McpUIMetadata {
    _meta?: {
        mcpUi?: boolean;
        [key: string]: unknown;
    };
    uiMetadata: {
        type?: string; // e.g., "html", "react-component-name", etc.
        html?: string; // Direct HTML content
        url?: string;  // Hosted UI resource
        data?: unknown; // Initial data for the UI
        [key: string]: unknown;
    };
}

interface McpUIRendererProps {
    metadata: McpUIMetadata;
    className?: string;
    onAction?: (action: string, data: unknown) => void;
}

export function McpUIRenderer({
    metadata,
    className,
    onAction,
}: McpUIRendererProps) {
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const [height, setHeight] = useState<number>(300); // Default height
    const [isLoading, setIsLoading] = useState(true);

    // Handle postMessage communication from the iframe
    useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            // Ensure the message is from our iframe
            if (
                iframeRef.current &&
                event.source !== iframeRef.current.contentWindow
            ) {
                return;
            }

            const data = event.data;
            if (!data || typeof data !== "object") return;

            // Handle standard MCP UI events
            switch (data.type) {
                case "mcp-ui:size":
                    // Dynamic resizing
                    if (typeof data.height === "number") {
                        setHeight(data.height);
                    }
                    break;

                case "mcp-ui:intent":
                case "mcp-ui:action":
                    // User interaction intent
                    if (onAction && data.action) {
                        onAction(data.action, data.payload);
                    }
                    break;

                case "mcp-ui:data-request":
                    // UI requesting data
                    // TODO: Implement data fetching from backend if needed
                    break;

                case "mcp-ui:ready":
                    setIsLoading(false);
                    // Send initial data if available
                    if (iframeRef.current?.contentWindow && metadata.uiMetadata.data) {
                        iframeRef.current.contentWindow.postMessage(
                            {
                                type: "mcp-ui:update-data",
                                data: metadata.uiMetadata.data,
                            },
                            "*"
                        );
                    }
                    break;
            }
        };

        window.addEventListener("message", handleMessage);
        return () => window.removeEventListener("message", handleMessage);
    }, [metadata.uiMetadata.data, onAction]);

    // Render logic based on metadata type
    // Priority: HTML content -> URL -> Fallback
    const renderContent = () => {
        const { html, url } = metadata.uiMetadata;

        if (html) {
            return (
                <iframe
                    ref={iframeRef}
                    srcDoc={html}
                    className="w-full h-full border-0"
                    style={{ height: `${height}px`, minHeight: "100px" }}
                    sandbox="allow-scripts allow-top-navigation-by-user-activation allow-forms allow-same-origin"
                    title="MCP UI Content"
                    onLoad={() => setIsLoading(false)}
                />
            );
        }

        if (url) {
            return (
                <iframe
                    ref={iframeRef}
                    src={url}
                    className="w-full h-full border-0"
                    style={{ height: `${height}px`, minHeight: "100px" }}
                    sandbox="allow-scripts allow-top-navigation-by-user-activation allow-forms allow-same-origin"
                    title="MCP UI Resource"
                    onLoad={() => setIsLoading(false)}
                />
            );
        }

        return (
            <div className="p-4 border border-dashed rounded text-muted-foreground text-sm text-center">
                Unsupported MCP UI Content
            </div>
        );
    };

    return (
        <div className={cn("relative w-full rounded-md border bg-card", className)}>
            {isLoading && (
                <div className="absolute inset-0 flex items-center justify-center bg-background/50 z-10">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
            )}
            {renderContent()}
        </div>
    );
}

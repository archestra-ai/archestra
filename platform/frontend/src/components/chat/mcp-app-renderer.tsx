"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export interface McpAppRendererProps {
  /** Decoded HTML string to render inside the sandboxed iframe. */
  htmlContent: string;
  /** Accessible title for the iframe — shown to screen readers. */
  title?: string;
  /** Additional class names applied to the iframe wrapper. */
  className?: string;
  /** Initial iframe height in pixels. Grows when the iframe reports a resize. */
  initialHeight?: number;
}

const MCP_APP_MIME = "text/html";
const DEFAULT_HEIGHT = 320;
const MAX_HEIGHT = 1200;

/**
 * McpAppRenderer
 *
 * Renders an MCP App (text/html;profile=mcp-app) inside a sandboxed iframe.
 *
 * Security design:
 *  - The HTML is loaded via a blob: URL, so its origin is opaque. Scripts
 *    inside the iframe cannot access host cookies, localStorage, or make
 *    credentialed requests to the app domain.
 *  - sandbox="allow-scripts" permits JavaScript but excludes same-origin
 *    framing, form submission, popups, and navigation.
 *  - Only structured postMessage events from the iframe's own contentWindow
 *    are processed; all other messages are ignored.
 *
 * Supported postMessage events from the iframe:
 *  - { type: "resize", height: number } — adjusts the iframe height
 *
 * The blob URL is revoked on unmount to avoid memory leaks.
 */
export function McpAppRenderer({
  htmlContent,
  title = "MCP App",
  className,
  initialHeight = DEFAULT_HEIGHT,
}: McpAppRendererProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(initialHeight);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  // Build a blob: URL for the HTML content and clean it up on unmount or change.
  useEffect(() => {
    const blob = new Blob([htmlContent], { type: MCP_APP_MIME });
    const url = URL.createObjectURL(blob);
    setBlobUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [htmlContent]);

  // Process postMessage events from the sandboxed iframe.
  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      // Only accept messages from our iframe. Because the iframe uses a blob:
      // URL its origin is "null", so we guard by contentWindow reference instead.
      if (
        !iframeRef.current ||
        event.source !== iframeRef.current.contentWindow
      ) {
        return;
      }

      const data = event.data;
      if (typeof data !== "object" || data === null) return;

      // Resize: the iframe content tells us how tall it needs to be.
      if (
        data.type === "resize" &&
        typeof data.height === "number" &&
        data.height > 0
      ) {
        setHeight(Math.min(Math.ceil(data.height), MAX_HEIGHT));
      }
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  if (!blobUrl) return null;

  return (
    <div
      className={cn(
        "mt-3 w-full overflow-hidden rounded-md border border-border/60",
        className,
      )}
    >
      <iframe
        ref={iframeRef}
        src={blobUrl}
        title={title}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        className="w-full border-0 bg-background"
        style={{ height }}
        scrolling="yes"
      />
    </div>
  );
}

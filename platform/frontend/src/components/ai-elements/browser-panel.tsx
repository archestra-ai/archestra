"use client";

import {
  ExternalLinkIcon,
  GlobeIcon,
  ImageIcon,
  Loader2Icon,
  MaximizeIcon,
  MousePointerClickIcon,
} from "lucide-react";
import Image from "next/image";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * Browser tool output content types from Playwright MCP
 */
interface BrowserTextContent {
  type: "text";
  text: string;
}

interface BrowserImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

type BrowserContent = BrowserTextContent | BrowserImageContent;

export interface BrowserPanelProps {
  /** Tool output content array from MCP */
  content?: BrowserContent[];
  /** Current URL being viewed */
  currentUrl?: string;
  /** Page title */
  pageTitle?: string;
  /** Whether the browser is loading */
  isLoading?: boolean;
  /** Tool name for context */
  toolName?: string;
  /** Additional CSS classes */
  className?: string;
}

/**
 * Extracts screenshot data from MCP tool output content
 */
function extractScreenshot(
  content?: BrowserContent[],
): { data: string; mimeType: string } | null {
  if (!content || !Array.isArray(content)) return null;

  const imageContent = content.find(
    (c): c is BrowserImageContent => c.type === "image",
  );

  if (imageContent) {
    return { data: imageContent.data, mimeType: imageContent.mimeType };
  }

  return null;
}

/**
 * Extracts text content from MCP tool output
 */
function extractText(content?: BrowserContent[]): string | null {
  if (!content || !Array.isArray(content)) return null;

  const textContent = content.find(
    (c): c is BrowserTextContent => c.type === "text",
  );

  return textContent?.text ?? null;
}

/**
 * Extracts URL from text content (common patterns in Playwright MCP output)
 */
function extractUrlFromText(text: string | null): string | null {
  if (!text) return null;

  // Try to find URL in common patterns
  const urlPatterns = [
    /Navigated to:\s*(.+)/i,
    /URL:\s*(.+)/i,
    /Current URL:\s*(.+)/i,
    /(https?:\/\/[^\s]+)/i,
  ];

  for (const pattern of urlPatterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return null;
}

/**
 * Gets an appropriate icon for the browser tool action
 */
function getToolIcon(toolName?: string) {
  if (!toolName) return <GlobeIcon className="size-4" />;

  const lowerName = toolName.toLowerCase();
  if (lowerName.includes("screenshot")) {
    return <ImageIcon className="size-4" />;
  }
  if (lowerName.includes("click")) {
    return <MousePointerClickIcon className="size-4" />;
  }
  if (lowerName.includes("navigate")) {
    return <GlobeIcon className="size-4" />;
  }

  return <GlobeIcon className="size-4" />;
}

/**
 * BrowserPanel - Displays browser automation output with screenshot preview
 *
 * Renders Playwright MCP tool output in a browser-like frame with:
 * - URL bar showing current page
 * - Screenshot viewport with zoom capability
 * - Text output for non-visual results
 */
export const BrowserPanel = ({
  content,
  currentUrl,
  pageTitle,
  isLoading = false,
  toolName,
  className,
}: BrowserPanelProps) => {
  const [isFullscreen, setIsFullscreen] = useState(false);

  const screenshot = extractScreenshot(content);
  const textOutput = extractText(content);
  const extractedUrl = extractUrlFromText(textOutput) ?? currentUrl;

  // If no meaningful content, don't render
  if (!screenshot && !textOutput && !isLoading) {
    return null;
  }

  const ScreenshotImage = screenshot ? (
    <Image
      src={`data:${screenshot.mimeType};base64,${screenshot.data}`}
      alt={pageTitle || "Browser screenshot"}
      fill
      className="object-contain"
      unoptimized // Base64 images don't need optimization
    />
  ) : null;

  return (
    <div
      className={cn(
        "browser-panel rounded-lg border bg-card overflow-hidden",
        className,
      )}
    >
      {/* Browser chrome / URL bar */}
      <div className="browser-chrome flex items-center gap-2 px-3 py-2 bg-muted/50 border-b">
        {/* Window controls (decorative) */}
        <div className="flex gap-1.5">
          <div className="size-3 rounded-full bg-red-400" />
          <div className="size-3 rounded-full bg-yellow-400" />
          <div className="size-3 rounded-full bg-green-400" />
        </div>

        {/* URL bar */}
        <div className="flex-1 flex items-center gap-2 px-3 py-1.5 rounded-md bg-background/50 text-xs">
          {getToolIcon(toolName)}
          <span className="truncate text-muted-foreground">
            {extractedUrl || "about:blank"}
          </span>
          {extractedUrl && (
            <a
              href={extractedUrl}
              target="_blank"
              rel="noopener noreferrer"
              title="Open in new tab"
              className="ml-auto text-muted-foreground hover:text-foreground transition-colors"
              onClick={(e) => e.stopPropagation()}
            >
              <ExternalLinkIcon className="size-3" />
              <span className="sr-only">Open in new tab</span>
            </a>
          )}
        </div>

        {/* Fullscreen toggle for screenshots */}
        {screenshot && (
          <Dialog open={isFullscreen} onOpenChange={setIsFullscreen}>
            <DialogTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={(e) => e.stopPropagation()}
              >
                <MaximizeIcon className="size-3.5" />
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-[90vw] max-h-[90vh] p-0">
              <DialogHeader className="p-4 pb-0">
                <DialogTitle className="flex items-center gap-2 text-sm">
                  <GlobeIcon className="size-4" />
                  {pageTitle || extractedUrl || "Browser Screenshot"}
                </DialogTitle>
              </DialogHeader>
              <div className="relative w-full h-[80vh] p-4">
                <Image
                  src={`data:${screenshot.mimeType};base64,${screenshot.data}`}
                  alt={pageTitle || "Browser screenshot"}
                  fill
                  className="object-contain"
                  unoptimized
                />
              </div>
            </DialogContent>
          </Dialog>
        )}
      </div>

      {/* Browser viewport */}
      <div className="browser-viewport relative bg-background">
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/80 z-10">
            <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {screenshot ? (
          <div className="relative aspect-video w-full">{ScreenshotImage}</div>
        ) : textOutput ? (
          <div className="p-4">
            <pre className="text-xs whitespace-pre-wrap text-muted-foreground font-mono overflow-x-auto">
              {textOutput}
            </pre>
          </div>
        ) : (
          <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">
            <GlobeIcon className="size-8 opacity-20" />
          </div>
        )}
      </div>

      {/* Page title footer (if available and different from URL) */}
      {pageTitle && pageTitle !== extractedUrl && (
        <div className="px-3 py-1.5 border-t bg-muted/30">
          <p className="text-xs text-muted-foreground truncate">{pageTitle}</p>
        </div>
      )}
    </div>
  );
};

/**
 * Helper to check if tool output is from a browser/Playwright tool
 */
export function isBrowserToolOutput(
  toolName: string,
  output: unknown,
): boolean {
  // Check if tool name indicates a browser tool
  const browserToolPatterns = [
    /^browser[_-]/i,
    /playwright/i,
    /^browser$/i,
    /navigate/i,
    /screenshot/i,
    /click/i,
    /^browser[A-Z]/,
  ];

  const isBrowserTool = browserToolPatterns.some((pattern) =>
    pattern.test(toolName),
  );

  if (!isBrowserTool) return false;

  // Check if output has expected structure
  if (!output || typeof output !== "object") return false;

  // Check for MCP content array structure
  if (Array.isArray(output)) {
    return output.some(
      (item) =>
        item &&
        typeof item === "object" &&
        "type" in item &&
        (item.type === "image" || item.type === "text"),
    );
  }

  // Check for nested content property
  if (
    "content" in output &&
    Array.isArray((output as { content: unknown[] }).content)
  ) {
    return true;
  }

  return false;
}

export default BrowserPanel;

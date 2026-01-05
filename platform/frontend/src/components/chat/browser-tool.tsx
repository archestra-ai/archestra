import type { DynamicToolUIPart, ToolUIPart } from "ai";
import { Camera, ChevronDown, Globe, MousePointer, Type } from "lucide-react";
import { useState } from "react";

interface BrowserToolArgs {
  url?: string;
  selector?: string;
  text?: string;
  direction?: string;
}

interface BrowserToolResultContent {
  type: "text" | "image";
  text?: string;
  data?: string;
  mimeType?: string;
}

interface BrowserToolResultPart {
  content?: BrowserToolResultContent[];
}

interface BrowserToolProps {
  part: ToolUIPart | DynamicToolUIPart;
  toolResultPart: ToolUIPart | DynamicToolUIPart | null;
  toolName: string;
}

// Type guard for BrowserToolArgs
function isBrowserToolArgs(args: unknown): args is BrowserToolArgs {
  return typeof args === "object" && args !== null;
}

// Type guard for BrowserToolResultPart
function isBrowserToolResultPart(part: unknown): part is BrowserToolResultPart {
  return typeof part === "object" && part !== null && "content" in part;
}

export function BrowserTool({
  part,
  toolResultPart,
  toolName,
}: BrowserToolProps) {
  const [isOpen, setIsOpen] = useState(true);

  // Parse args safe
  let args: BrowserToolArgs = {};
  if ("args" in part && isBrowserToolArgs(part.args)) {
    args = part.args;
  }

  // Determine action type and icon
  let Icon = Globe;
  let title = "Browser Action";
  let details = "";

  if (toolName.includes("navigate")) {
    Icon = Globe;
    title = "Navigating";
    details = args.url || "Unknown URL";
  } else if (toolName.includes("click")) {
    Icon = MousePointer;
    title = "Clicking";
    details = args.selector || "Unknown element";
  } else if (toolName.includes("type")) {
    Icon = Type;
    title = "Typing";
    details = `${args.text || ""} into ${args.selector || ""}`;
  } else if (toolName.includes("screenshot")) {
    Icon = Camera;
    title = "Taking Screenshot";
  } else if (toolName.includes("scroll")) {
    Icon = ChevronDown;
    title = "Scrolling";
    details = args.direction || "down";
  }

  // Parse result
  let resultText = "";
  let screenshotBase64 = "";

  if (toolResultPart && isBrowserToolResultPart(toolResultPart)) {
    const resultPart = toolResultPart;

    if (resultPart.content && Array.isArray(resultPart.content)) {
      resultPart.content.forEach((c) => {
        if (c.type === "text" && c.text) {
          const text = c.text;
          if (text.startsWith("[SCREENSHOT_BASE64]")) {
            screenshotBase64 = text.replace("[SCREENSHOT_BASE64]", "");
          } else {
            resultText += text;
          }
        }
      });
    }
  }

  return (
    <div className="flex flex-col rounded-md border border-border bg-card/50 overflow-hidden my-2">
      <button
        type="button"
        className="flex w-full items-center justify-between p-3 cursor-pointer hover:bg-muted/50 transition-colors"
        onClick={() => setIsOpen(!isOpen)}
      >
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-md bg-primary/10 text-primary">
            <Icon size={16} />
          </div>
          <div className="flex flex-col items-start">
            <span className="text-sm font-medium">{title}</span>
            {details && (
              <span className="text-xs text-muted-foreground opacity-80 font-mono truncate max-w-[300px]">
                {details}
              </span>
            )}
          </div>
        </div>
        <div className="text-muted-foreground">
          {isOpen ? (
            <ChevronDown size={14} />
          ) : (
            <ChevronDown size={14} className="-rotate-90" />
          )}
        </div>
      </button>

      {isOpen && (
        <div className="p-3 pt-0 border-t border-border/50 bg-background/30">
          {screenshotBase64 && (
            <div className="mt-3 overflow-hidden rounded-lg border border-border shadow-sm">
              <img
                src={`data:image/jpeg;base64,${screenshotBase64}`}
                alt="Browser Screenshot"
                className="w-full h-auto max-h-[400px] object-contain bg-white"
              />
            </div>
          )}

          {resultText && (
            <div className="mt-2 text-xs font-mono text-muted-foreground whitespace-pre-wrap break-words bg-muted/30 p-2 rounded">
              {resultText}
            </div>
          )}

          {!screenshotBase64 && !resultText && (
            <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground/70 italic">
              <div className="h-2 w-2 rounded-full bg-primary/50 animate-pulse" />
              Executing...
            </div>
          )}
        </div>
      )}
    </div>
  );
}

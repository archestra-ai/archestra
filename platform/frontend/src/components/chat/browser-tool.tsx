import type { DynamicToolUIPart, ToolUIPart } from "ai";
import {
  Camera,
  ChevronDown,
  ChevronUp,
  Globe,
  MousePointer,
  Type,
} from "lucide-react";
import { useState } from "react";

interface BrowserToolArgs {
  url?: string;
  selector?: string;
  text?: string;
  direction?: string;
}

interface BrowserToolResultContent {
  type: "text" | "image"; // expanding for future proofing
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

export function BrowserTool({
  part,
  toolResultPart,
  toolName,
}: BrowserToolProps) {
  const [isOpen, setIsOpen] = useState(true);

  // Parse args safely
  // biome-ignore lint/suspicious/noExplicitAny: Generic tool part input is loosely typed
  const args = (part as any).args as BrowserToolArgs;

  // Determine action type and icon
  let Icon = Globe;
  let title = "Browser Action";
  let details = "";

  if (toolName.includes("navigate")) {
    Icon = Globe;
    title = "Navigating";
    details = (args?.url as string) || "Unknown URL";
  } else if (toolName.includes("click")) {
    Icon = MousePointer;
    title = "Clicking";
    details = (args?.selector as string) || "Unknown element";
  } else if (toolName.includes("type")) {
    Icon = Type;
    title = "Typing";
    details = `${args?.text} into ${args?.selector}`;
  } else if (toolName.includes("screenshot")) {
    Icon = Camera;
    title = "Taking Screenshot";
  } else if (toolName.includes("scroll")) {
    Icon = ChevronDown;
    title = "Scrolling";
    details = (args?.direction as string) || "down";
  }

  // Parse result
  let resultText = "";
  let screenshotBase64 = "";

  if (toolResultPart) {
    // biome-ignore lint/suspicious/noExplicitAny: Accessing dynamic tool result structure
    const resultPart = toolResultPart as any as BrowserToolResultPart;

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
              <span className="text-xs text-muted-foreground truncate max-w-[300px]">
                {details}
              </span>
            )}
          </div>
        </div>
        <div className="text-muted-foreground hover:text-foreground">
          {isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </div>
      </button>

      {isOpen && (
        <div className="border-t border-border p-3 bg-card">
          {screenshotBase64 ? (
            <div className="relative aspect-video w-full overflow-hidden rounded-md border border-border">
              <img
                src={`data:image/jpeg;base64,${screenshotBase64}`}
                alt="Browser Screenshot"
                className="object-cover w-full h-full"
              />
            </div>
          ) : resultText ? (
            <div className="text-xs font-mono bg-muted p-2 rounded-md overflow-x-auto whitespace-pre-wrap">
              {resultText}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground italic">
              Executing...
            </div>
          )}
        </div>
      )}
    </div>
  );
}

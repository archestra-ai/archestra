import { type DynamicToolUIPart, type ToolUIPart } from "ai";
import { useState } from "react";
import { ChevronDown, ChevronUp, Globe, MousePointer, Camera, Type } from "lucide-react";
import { cn } from "@/lib/utils";

interface BrowserToolProps {
    part: ToolUIPart | DynamicToolUIPart;
    toolResultPart: ToolUIPart | DynamicToolUIPart | null;
    toolName: string;
}

export function BrowserTool({ part, toolResultPart, toolName }: BrowserToolProps) {
    const [isOpen, setIsOpen] = useState(true);

    // Parse args
    const args = (part as any).args as Record<string, unknown>;

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

    if (toolResultPart && (toolResultPart as any).content) {
        if (Array.isArray((toolResultPart as any).content)) {
            (toolResultPart as any).content.forEach((c: any) => {
                if (c.type === "text") {
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
            <div
                className="flex items-center justify-between p-3 cursor-pointer hover:bg-muted/50 transition-colors"
                onClick={() => setIsOpen(!isOpen)}
            >
                <div className="flex items-center gap-2">
                    <div className="p-1.5 rounded-md bg-primary/10 text-primary">
                        <Icon size={16} />
                    </div>
                    <div className="flex flex-col">
                        <span className="text-sm font-medium">{title}</span>
                        {details && <span className="text-xs text-muted-foreground truncate max-w-[300px]">{details}</span>}
                    </div>
                </div>
                <button className="text-muted-foreground hover:text-foreground">
                    {isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </button>
            </div>

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

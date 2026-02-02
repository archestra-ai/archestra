"use client";

import { Copy, Download, FileText, GripVertical, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import { MermaidDiagram } from "@/components/mermaid-diagram";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ConversationArtifactPanelProps {
  artifact?: string | null;
  isOpen: boolean;
  onToggle: () => void;
  className?: string;
  /** When true, the panel fills its container and doesn't manage its own width/resize */
  embedded?: boolean;
}

export function ConversationArtifactPanel({
  artifact,
  isOpen,
  onToggle,
  className,
  embedded = false,
}: ConversationArtifactPanelProps) {
  const [width, setWidth] = useState(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("archestra-artifact-panel-width");
      return saved ? Number.parseInt(saved, 10) : 500;
    }
    return 500;
  });
  const [isResizing, setIsResizing] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;

      const newWidth = window.innerWidth - e.clientX;
      const minWidth = 300;
      const maxWidth = window.innerWidth * 0.7;

      const clampedWidth = Math.max(minWidth, Math.min(maxWidth, newWidth));
      setWidth(clampedWidth);
      localStorage.setItem(
        "archestra-artifact-panel-width",
        clampedWidth.toString(),
      );
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    if (isResizing) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    }

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizing]);

  // Custom components for ReactMarkdown to handle Mermaid diagrams
  const markdownComponents: Components = {
    code({ node, className, children, ...props }) {
      const match = /language-(\w+)/.exec(className || "");
      const language = match ? match[1] : "";

      if (language === "mermaid") {
        const code = String(children).replace(/\n$/, "");
        return (
          <div className="my-4 max-h-[600px] [&_svg]:!max-h-[600px] [&_svg]:!w-auto">
            <MermaidDiagram chart={code} id={`mermaid-${Date.now()}`} />
          </div>
        );
      }

      // Default code block rendering
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    },
  };

  const handleCopy = async () => {
    if (!artifact) {
      toast.error("No artifact to copy");
      return;
    }
    try {
      await navigator.clipboard.writeText(artifact);
      toast.success("Artifact copied to clipboard");
    } catch (_error) {
      toast.error("Failed to copy artifact");
    }
  };

  const handleDownload = () => {
    if (!artifact) {
      toast.error("No artifact to download");
      return;
    }

    // Use browser's print functionality to save as PDF
    const printWindow = window.open("", "_blank");

    if (!printWindow || !contentRef.current) {
      toast.error("Unable to generate PDF. Please check popup settings.");
      return;
    }

    // Get the content HTML
    const content = contentRef.current.innerHTML;

    // Create a complete HTML document with print-optimized styles
    const printDocument = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <title>Conversation Artifact</title>
          <style>
            @page {
              size: A4;
              margin: 20mm;
            }
            
            @media print {
              body {
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                line-height: 1.6;
                color: #000;
                background: #fff;
              }
            }
            
            body {
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
              line-height: 1.6;
              padding: 20px;
              max-width: 800px;
              margin: 0 auto;
              color: #333;
            }
            
            h1 {
              font-size: 2em;
              font-weight: bold;
              margin: 0.67em 0;
              page-break-after: avoid;
            }
            
            h2 {
              font-size: 1.5em;
              font-weight: bold;
              margin: 0.75em 0;
              page-break-after: avoid;
            }
            
            h3 {
              font-size: 1.17em;
              font-weight: semibold;
              margin: 0.83em 0;
              page-break-after: avoid;
            }
            
            p {
              margin: 1em 0;
            }
            
            ul, ol {
              margin: 1em 0;
              padding-left: 2em;
            }
            
            li {
              margin: 0.5em 0;
            }
            
            code {
              background: #f4f4f4;
              padding: 0.2em 0.4em;
              border-radius: 3px;
              font-family: monospace;
            }
            
            pre {
              background: #f4f4f4;
              padding: 1em;
              border-radius: 5px;
              overflow-x: auto;
              page-break-inside: avoid;
            }
            
            pre code {
              background: none;
              padding: 0;
            }
            
            table {
              border-collapse: collapse;
              width: 100%;
              margin: 1em 0;
              page-break-inside: avoid;
            }
            
            th, td {
              border: 1px solid #ddd;
              padding: 8px;
              text-align: left;
            }
            
            th {
              background-color: #f4f4f4;
              font-weight: bold;
            }
            
            blockquote {
              border-left: 4px solid #ddd;
              padding-left: 1em;
              margin-left: 0;
              color: #666;
              font-style: italic;
            }
            
            hr {
              border: none;
              border-top: 1px solid #ddd;
              margin: 2em 0;
            }
            
            a {
              color: #0066cc;
              text-decoration: underline;
            }
            
            strong {
              font-weight: bold;
            }
            
            em {
              font-style: italic;
            }
            
            del {
              text-decoration: line-through;
            }
            
            /* Hide Mermaid diagrams in print as they won't render properly */
            svg {
              max-width: 100%;
              page-break-inside: avoid;
            }
          </style>
        </head>
        <body>
          ${content}
        </body>
      </html>
    `;

    // Write the content to the new window
    printWindow.document.write(printDocument);
    printWindow.document.close();

    // Wait for content to load then trigger print
    printWindow.onload = () => {
      setTimeout(() => {
        printWindow.print();
        // The user can save as PDF from the print dialog
        toast.success("Print dialog opened - select 'Save as PDF' to download");

        // Close the window after print dialog is closed
        printWindow.onafterprint = () => {
          printWindow.close();
        };
      }, 500);
    };
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div
      ref={panelRef}
      style={embedded ? undefined : { width: `${width}px` }}
      className={cn(
        "h-full bg-background flex flex-col relative",
        !embedded && "border-l",
        className,
      )}
    >
      {/* Resize handle - only shown when not embedded */}
      {!embedded && (
        // biome-ignore lint/a11y/useSemanticElements: This is a draggable resize handle, not a semantic separator
        <div
          className="absolute left-0 top-0 bottom-0 w-1 hover:w-2 cursor-col-resize bg-transparent hover:bg-primary/10 transition-all"
          onMouseDown={handleMouseDown}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize artifact panel"
          aria-valuenow={width}
          aria-valuemin={300}
          aria-valuemax={
            typeof window !== "undefined" ? window.innerWidth * 0.7 : 1000
          }
          tabIndex={0}
        >
          <div className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-1/2 opacity-0 hover:opacity-100 transition-opacity">
            <GripVertical className="h-4 w-4 text-muted-foreground" />
          </div>
        </div>
      )}

      {/* Panel header */}
      <div className="border-b px-2 pr-1 py-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-medium text-xs">Conversation Artifact</h3>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={handleCopy}
            title="Copy to clipboard"
          >
            <Copy className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={handleDownload}
            title="Download as PDF"
          >
            <Download className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={onToggle}
            title="Close panel"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Panel content */}
      <div className="flex-1 overflow-y-auto">
        <div ref={contentRef} className="px-6 py-4 max-w-none h-full">
          {artifact ? (
            <div className="size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_ul]:list-disc [&_ul]:ml-6 [&_ul]:my-2 [&_ol]:list-decimal [&_ol]:ml-6 [&_ol]:my-2 [&_li]:my-1 [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:my-4 [&_h2]:text-xl [&_h2]:font-bold [&_h2]:my-3 [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:my-2 [&_p]:my-2 [&_code]:bg-muted [&_code]:text-foreground [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_pre]:bg-muted [&_pre]:p-3 [&_pre]:rounded [&_pre]:my-2 [&_pre]:overflow-x-auto [&_table]:border-collapse [&_table]:w-full [&_table]:my-4 [&_table]:border [&_table]:border-border [&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-2 [&_th]:border [&_th]:border-border [&_th]:px-3 [&_th]:py-2 [&_th]:bg-muted [&_th]:font-semibold [&_thead]:bg-muted">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={markdownComponents}
              >
                {artifact}
              </ReactMarkdown>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
              <FileText className="h-12 w-12 mb-4" />
              <p className="text-lg font-medium">No artifact yet</p>
              <p className="text-sm mt-2 text-center">
                The agent hasn't created an artifact in this conversation
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

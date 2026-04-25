"use client";

import mermaid from "mermaid";
import { AlertTriangle } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";

interface MermaidDiagramProps {
  chart: string;
  id?: string;
}

export function MermaidDiagram({
  chart,
  id = "mermaid-diagram",
}: MermaidDiagramProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { theme } = useTheme();
  const [isLoaded, setIsLoaded] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    setIsLoaded(false);
    setRenderError(null);

    const isDark = theme === "dark";

    mermaid.initialize({
      startOnLoad: false,
      theme: isDark ? "dark" : "neutral",
      themeVariables: isDark
        ? {
            primaryColor: "#374151",
            primaryBorderColor: "#4b5563",
            primaryTextColor: "#f3f4f6",
            lineColor: "#9ca3af",
            background: "#1f2937",
            mainBkg: "#374151",
            secondBkg: "#4b5563",
            tertiaryColor: "#6b7280",
            fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
          }
        : {
            primaryColor: "#f3f4f6",
            primaryBorderColor: "#9ca3af",
            primaryTextColor: "#000",
            lineColor: "#5e5e5e",
            background: "#f9fafb",
            mainBkg: "#f3f4f6",
            secondBkg: "#e5e7eb",
            tertiaryColor: "#d1d5db",
            fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
          },
    });

    const uniqueId = `${id}-${Date.now()}`;

    const renderDiagram = async () => {
      if (ref.current) {
        ref.current.replaceChildren();

        // Clean up any previous orphaned mermaid node
        const prevNode = document.getElementById(`d${uniqueId}`);
        if (prevNode) prevNode.remove();

        try {
          const { svg } = await mermaid.render(uniqueId, chart);
          if (ref.current) {
            const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
            const svgElement = doc.documentElement;
            ref.current.replaceChildren(svgElement);
            requestAnimationFrame(() => setIsLoaded(true));
          }
        } catch (error) {
          setRenderError(error instanceof Error ? error.message : String(error));
          setIsLoaded(true);
        } finally {
          // Always clean up the temporary node mermaid attaches to document.body
          const tempNode = document.getElementById(`d${uniqueId}`);
          if (tempNode) tempNode.remove();
        }
      }
    };

    renderDiagram();
  }, [chart, id, theme]);

  if (renderError) {
    return (
      <Alert variant="warning" className="my-4">
        <AlertTriangle className="h-4 w-4" />
        <AlertDescription>
          <div className="text-sm font-medium mb-1">Invalid diagram</div>
          <div className="text-xs text-muted-foreground mb-2">
            Could not render Mermaid diagram
          </div>
          <pre className="text-xs bg-muted/50 p-2 rounded overflow-auto max-h-24">
            {chart}
          </pre>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div
      ref={ref}
      className={`flex justify-center w-full [&_svg]:!max-w-full [&_svg]:!h-auto transition-opacity duration-300 motion-reduce:transition-none ${
        isLoaded ? "opacity-100" : "opacity-0"
      }`}
    />
  );
}

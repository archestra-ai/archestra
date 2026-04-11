"use client";

import mermaid from "mermaid";
import { AlertTriangle } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

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
            // Dark mode colors
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
            // Light mode colors
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

    const renderDiagram = async () => {
      if (ref.current) {
        ref.current.replaceChildren();
        try {
          // Generate a unique ID to avoid conflicts
          const uniqueId = `${id}-${Date.now()}`;
          const { svg } = await mermaid.render(uniqueId, chart);
          // Clean up any orphaned mermaid temp element that may have been
          // attached to the document body during rendering
          document.querySelector(`#d${uniqueId}`)?.remove();
          if (ref.current) {
            // Parse SVG string via DOMParser to avoid innerHTML
            const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
            const svgElement = doc.documentElement;
            ref.current.replaceChildren(svgElement);
            requestAnimationFrame(() => setIsLoaded(true));
          }
        } catch (error) {
          console.error("Error rendering mermaid diagram:", error);
          const message =
            error instanceof Error ? error.message : "Unknown render error";
          setRenderError(message);
          setIsLoaded(true);
        }
      }
    };

    renderDiagram();
  }, [chart, id, theme]);

  if (renderError !== null) {
    return (
      <Alert variant="warning" className="my-2">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>Diagram could not be rendered</AlertTitle>
        <AlertDescription>
          <p className="mb-2">
            The diagram syntax is invalid. Check the source and try again.
          </p>
          <pre className="overflow-auto max-h-24 text-xs whitespace-pre-wrap break-all bg-amber-100/50 dark:bg-amber-950/30 rounded p-2">
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

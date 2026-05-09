"use client";

import { AlertTriangle } from "lucide-react";
import mermaid from "mermaid";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useRef, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

interface MermaidDiagramProps {
  chart: string;
  id?: string;
}

/**
 * Remove orphaned elements that mermaid.render() leaves in document.body
 * when parsing or rendering fails. Mermaid attaches temporary containers
 * using both the supplied id and a `d`-prefixed variant.
 */
function cleanupMermaidArtifacts(uniqueId: string) {
  document.getElementById(uniqueId)?.remove();
  document.getElementById(`d${uniqueId}`)?.remove();
}

export function MermaidDiagram({
  chart,
  id = "mermaid-diagram",
}: MermaidDiagramProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { theme } = useTheme();
  const [isLoaded, setIsLoaded] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);

  // Track generated ids so we can clean them up on unmount
  const generatedIdsRef = useRef<string[]>([]);

  const cleanup = useCallback(() => {
    for (const gid of generatedIdsRef.current) {
      cleanupMermaidArtifacts(gid);
    }
    generatedIdsRef.current = [];
  }, []);

  useEffect(() => {
    let cancelled = false;

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
      // Clean up any previous render artifacts before starting a new one
      cleanup();

      if (!ref.current) return;

      ref.current.replaceChildren();

      const uniqueId = `${id}-${Date.now()}`;
      generatedIdsRef.current.push(uniqueId);

      try {
        const { svg } = await mermaid.render(uniqueId, chart);

        if (cancelled || !ref.current) return;

        // Parse SVG string via DOMParser to avoid innerHTML
        const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
        const svgElement = doc.documentElement;
        ref.current.replaceChildren(svgElement);
        requestAnimationFrame(() => {
          if (!cancelled) setIsLoaded(true);
        });
      } catch (error) {
        // Clean up the orphaned temp element mermaid leaves in document.body
        cleanupMermaidArtifacts(uniqueId);

        if (cancelled || !ref.current) return;

        console.error("Error rendering mermaid diagram:", error);
        setRenderError(
          error instanceof Error ? error.message : "Invalid diagram syntax",
        );
        setIsLoaded(true);
      }
    };

    renderDiagram();

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [chart, cleanup, id, theme]);

  if (renderError) {
    return (
      <Alert variant="warning">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>Diagram could not be rendered</AlertTitle>
        <AlertDescription>
          <p>{renderError}</p>
          <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-muted p-3 text-xs">
            <code>{chart}</code>
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

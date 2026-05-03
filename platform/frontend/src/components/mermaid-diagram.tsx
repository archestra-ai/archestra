"use client";

import mermaid from "mermaid";
import { useTheme } from "next-themes";
import { useEffect, useRef, useState } from "react";

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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setIsLoaded(false);
    setError(null);
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
        const uniqueId = `${id}-${Date.now()}`;
        try {
          const { svg } = await mermaid.render(uniqueId, chart);
          if (ref.current) {
            // Parse SVG string via DOMParser to avoid innerHTML
            const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
            const svgElement = doc.documentElement;
            ref.current.replaceChildren(svgElement);
            requestAnimationFrame(() => setIsLoaded(true));
          }
        } catch (err) {
          document.getElementById(uniqueId)?.remove();
          const message = err instanceof Error ? err.message : String(err);
          setError(message);
          setIsLoaded(true);
        }
      }
    };

    renderDiagram();
  }, [chart, id, theme]);

  if (error) {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-destructive text-xs whitespace-pre-wrap break-words select-text">
        <p className="font-medium mb-1">Invalid diagram</p>
        {error}
      </div>
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

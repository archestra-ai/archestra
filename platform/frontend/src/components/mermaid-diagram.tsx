"use client";

import mermaid from "mermaid";
import { useTheme } from "next-themes";
import { useEffect, useRef } from "react";

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

  useEffect(() => {
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
        ref.current.innerHTML = "";
        try {
          // Generate a unique ID to avoid conflicts
          const uniqueId = `${id}-${Date.now()}`;
          const { svg } = await mermaid.render(uniqueId, chart);
          ref.current.innerHTML = svg;
        } catch (error) {
          console.error("Error rendering mermaid diagram:", error);
          ref.current.innerHTML = `<pre>${chart}</pre>`;
        }
      }
    };

    renderDiagram();
  }, [chart, id, theme]);

  return (
    <div
      ref={ref}
      className="flex justify-center w-full [&_svg]:!max-w-full [&_svg]:!h-auto"
    />
  );
}

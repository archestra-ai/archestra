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
  const [isInitialized, setIsInitialized] = useState(false);

  useEffect(() => {
    mermaid.initialize({
      startOnLoad: false,
      theme: theme === "dark" ? "dark" : "neutral",
      themeVariables: {
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
    setIsInitialized(true);
  }, [theme]);

  useEffect(() => {
    if (!isInitialized) return;

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
  }, [chart, id, isInitialized]);

  return (
    <div
      ref={ref}
      className="flex justify-center w-full [&_svg]:!max-w-full [&_svg]:!h-auto"
    />
  );
}

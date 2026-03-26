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

  useEffect(() => {
    setIsLoaded(false);
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
          if (ref.current) {
            // Parse SVG string via DOMParser to avoid innerHTML
            const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
            const svgElement = doc.documentElement;
            ref.current.replaceChildren(svgElement);
            requestAnimationFrame(() => setIsLoaded(true));
          }
        } catch (error) {
          console.error("Error rendering mermaid diagram:", error);
          if (ref.current) {
            // Clean up any mermaid-generated elements that may have leaked into document.body
            const leakedElements = document.body.querySelectorAll('[id^="mermaid-"]');
            leakedElements.forEach((el) => el.remove());
            // Also clean up the injected <div> that mermaid sometimes creates
            const mermaidDivs = document.body.querySelectorAll('.mermaid');
            mermaidDivs.forEach((el) => el.remove());

            const pre = document.createElement("pre");
            pre.textContent = chart;
            pre.className = "text-red-500 text-sm p-2 bg-red-50 dark:bg-red-950 rounded border border-red-200 dark:border-red-800 overflow-auto";
            ref.current.replaceChildren(pre);
            setIsLoaded(true);
          }
        }
      }
    };

    renderDiagram();
  }, [chart, id, theme]);

  return (
    <div
      ref={ref}
      className={`flex justify-center w-full [&_svg]:!max-w-full [&_svg]:!h-auto transition-opacity duration-300 motion-reduce:transition-none ${
        isLoaded ? "opacity-100" : "opacity-0"
      }`}
    />
  );
}

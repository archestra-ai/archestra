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
      // When render fails, mermaid creates a temporary container div in
      // document.body and renders an error SVG inside it. Without this flag
      // that container is never removed, so it outlives the React component
      // and shows up as a stale error on unrelated pages. See #3511.
      suppressErrorRendering: true,
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

    const renderInlineError = (message: string) => {
      if (!ref.current) return;
      const wrapper = document.createElement("div");
      wrapper.className =
        "w-full rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-left";
      const heading = document.createElement("p");
      heading.className = "font-medium text-destructive";
      heading.textContent = message;
      const pre = document.createElement("pre");
      pre.className = "mt-2 overflow-x-auto text-xs opacity-70";
      pre.textContent = chart;
      wrapper.appendChild(heading);
      wrapper.appendChild(pre);
      ref.current.replaceChildren(wrapper);
      setIsLoaded(true);
    };

    const renderDiagram = async () => {
      if (!ref.current) return;
      ref.current.replaceChildren();

      // Belt-and-suspenders: suppressErrorRendering handles cleanup if render()
      // fails, but pre-validating avoids calling render() at all for bad input.
      try {
        const parseResult = await mermaid.parse(chart, {
          suppressErrors: true,
        });
        if (parseResult === false) {
          renderInlineError("Invalid mermaid diagram syntax");
          return;
        }
      } catch (error) {
        console.error("Error parsing mermaid diagram:", error);
        renderInlineError("Invalid mermaid diagram syntax");
        return;
      }

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
        renderInlineError("Failed to render mermaid diagram");
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

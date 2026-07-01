"use client";

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
    let isCancelled = false;
    setIsLoaded(false);
    const isDark = theme === "dark";

    const renderDiagram = async () => {
      if (ref.current) {
        ref.current.replaceChildren();
        try {
          const { default: mermaid } = await import("mermaid");
          if (isCancelled) return;

          mermaid.initialize({
            startOnLoad: false,
            // On a parse/draw failure, mermaid otherwise appends an error
            // "bomb" diagram to document.body and throws before removing it,
            // orphaning that node outside React's tree. Suppressing it makes
            // render() clean up its scratch element before throwing.
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
                  fontFamily:
                    "ui-sans-serif, system-ui, -apple-system, sans-serif",
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
                  fontFamily:
                    "ui-sans-serif, system-ui, -apple-system, sans-serif",
                },
          });

          // Generate a unique ID to avoid conflicts
          const uniqueId = `${id}-${Date.now()}`;
          const { svg } = await mermaid.render(uniqueId, chart);
          if (ref.current && !isCancelled) {
            // Parse SVG string via DOMParser to avoid innerHTML
            const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
            const svgElement = doc.documentElement;
            ref.current.replaceChildren(svgElement);
            requestAnimationFrame(() => setIsLoaded(true));
          }
        } catch (error) {
          console.error("Error rendering mermaid diagram:", error);
          // Match the success path's guard: a stale rejected render (from an
          // older chart/theme) must not overwrite a newer render's output.
          if (ref.current && !isCancelled) {
            const message =
              error instanceof Error ? error.message : String(error);

            const box = document.createElement("div");
            box.setAttribute("role", "alert");
            box.className =
              "w-full rounded-md border border-destructive/30 bg-destructive/10 p-3 text-left text-sm text-destructive";

            const title = document.createElement("p");
            title.className = "font-medium";
            title.textContent = "Couldn't render the diagram";
            box.appendChild(title);

            // The catch also covers non-syntax failures (e.g. the dynamic
            // mermaid import), so only claim invalid syntax on a parse error.
            if (/parse error/i.test(message)) {
              const hint = document.createElement("p");
              hint.className = "mt-1 text-xs text-muted-foreground";
              hint.textContent = "The mermaid syntax is invalid.";
              box.appendChild(hint);
            }

            // Keep the parse error and the source available, but out of the way.
            const details = document.createElement("details");
            details.className = "mt-2";
            const summary = document.createElement("summary");
            summary.className = "cursor-pointer text-xs text-muted-foreground";
            summary.textContent = "Show details";
            details.appendChild(summary);
            const pre = document.createElement("pre");
            pre.className = "mt-1 overflow-x-auto whitespace-pre-wrap text-xs";
            pre.textContent = `${message}\n\n${chart}`;
            details.appendChild(pre);
            box.appendChild(details);

            ref.current.replaceChildren(box);
            setIsLoaded(true);
          }
        }
      }
    };

    renderDiagram();

    return () => {
      isCancelled = true;
    };
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

import { createLucideIcon } from "lucide-react";
import type { SVGProps } from "react";

// The glyph traces the published pixel mark’s silhouette, eye cutouts, and muzzle.
export const OpenAppaIcon = createLucideIcon("OpenAppa", [
  [
    "path",
    {
      key: "silhouette",
      d: "M5 0h2M17 0h2M4 2h1M7 2h10M19 2h1M3 3h1M20 3h1M6 6h3M15 6h3M6 9h3M15 9h3M11 11h2M11 12h2M3 13h1M20 13h1M1 14h3M20 14h3M0 15h1M23 15h1M5 20h2M11 20h2M17 20h2M0 22h5M7 22h4M13 22h4M19 22h5M0 15v7M1 14v1M3 3v10M4 2v1M4 13v1M5 0v2M5 20v2M6 6v3M7 0v2M7 20v2M9 6v3M11 11v1M11 20v2M13 11v1M13 20v2M15 6v3M17 0v2M17 20v2M18 6v3M19 0v2M19 20v2M20 2v1M20 13v1M21 3v10M23 14v1M24 15v7",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "1.5",
      strokeLinecap: "square",
      strokeLinejoin: "miter",
      transform: "translate(1.2 1.2) scale(0.9)",
    },
  ],
  [
    "path",
    {
      key: "muzzle",
      d: "M10 10h4M11 11h2M10 12h1M13 12h1M10 10v2M11 11v1M13 11v1M14 10v2",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "1.5",
      strokeLinecap: "square",
      strokeLinejoin: "miter",
      transform: "translate(1.2 1.2) scale(0.9)",
    },
  ],
]);

// The original filled mark is used for the enabled status.
export function OpenAppaSolidIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 22" fill="none" aria-hidden="true" {...props}>
      <path
        d="M5 0h2v1h-2zM17 0h2v1h-2zM5 1h2v1h-2zM17 1h2v1h-2zM4 2h16v1h-16zM3 3h18v1h-18zM3 4h18v1h-18zM3 5h18v1h-18zM3 6h3v1h-3zM9 6h6v1h-6zM18 6h3v1h-3zM3 7h3v1h-3zM9 7h6v1h-6zM18 7h3v1h-3zM3 8h3v1h-3zM9 8h6v1h-6zM18 8h3v1h-3zM3 9h18v1h-18zM3 10h7v1h-7zM14 10h7v1h-7zM3 11h7v1h-7zM14 11h7v1h-7zM3 12h18v1h-18zM4 13h16v1h-16zM1 14h22v1h-22zM0 15h24v1h-24zM0 16h24v1h-24zM0 17h24v1h-24zM0 18h24v1h-24zM0 19h24v1h-24zM0 20h5v1h-5zM7 20h4v1h-4zM13 20h4v1h-4zM19 20h5v1h-5z"
        fill="currentColor"
        shapeRendering="crispEdges"
      />
      <path
        d="M10 10h4v1h-4zM10 11h1v1h-1zM13 11h1v1h-1zM0 21h5v1h-5zM7 21h4v1h-4zM13 21h4v1h-4zM19 21h5v1h-5z"
        fill="currentColor"
        opacity="0.6"
        shapeRendering="crispEdges"
      />
    </svg>
  );
}

// The warning variant keeps the official alert mark’s pixel shape and spark.
export function OpenAppaAlertIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 34 22" fill="none" aria-hidden="true" {...props}>
      <path
        d="M10 0h2v1h-2zM22 0h2v1h-2zM10 1h2v1h-2zM22 1h2v1h-2zM9 2h16v1h-16zM8 3h18v1h-18zM8 4h18v1h-18zM8 5h2v1h-2zM12 5h10v1h-10zM24 5h2v1h-2zM8 6h3v1h-3zM13 6h8v1h-8zM23 6h3v1h-3zM8 7h5v1h-5zM14 7h6v1h-6zM21 7h5v1h-5zM8 8h2v1h-2zM12 8h10v1h-10zM24 8h2v1h-2zM8 9h6v1h-6zM20 9h6v1h-6zM8 10h6v1h-6zM20 10h6v1h-6zM8 11h6v1h-6zM20 11h6v1h-6zM8 12h6v1h-6zM20 12h6v1h-6zM9 13h5v1h-5zM20 13h5v1h-5zM6 14h8v1h-8zM20 14h8v1h-8zM6 15h22v1h-22zM5 16h24v1h-24zM5 17h24v1h-24zM5 18h24v1h-24zM5 19h24v1h-24zM5 20h5v1h-5zM12 20h4v1h-4zM18 20h4v1h-4zM24 20h5v1h-5z"
        fill="currentColor"
        shapeRendering="crispEdges"
      />
      <path
        d="M11 6h1v1h-1zM22 6h1v1h-1zM14 9h6v1h-6zM14 10h2v1h-2zM18 10h2v1h-2zM14 11h1v1h-1zM19 11h1v1h-1zM14 12h1v1h-1zM19 12h1v1h-1zM14 13h1v1h-1zM19 13h1v1h-1zM14 14h1v1h-1zM19 14h1v1h-1zM5 21h5v1h-5zM12 21h4v1h-4zM18 21h4v1h-4zM24 21h5v1h-5z"
        fill="currentColor"
        opacity="0.6"
        shapeRendering="crispEdges"
      />
      <path
        d="M15 11h4v1h-4zM15 12h4v1h-4zM15 13h4v1h-4z"
        fill="currentColor"
        shapeRendering="crispEdges"
      />
      <path
        d="M0 3h2v1h-2zM32 3h2v1h-2zM1 4h2v1h-2zM31 4h2v1h-2zM2 5h3v1h-3zM29 5h3v1h-3zM3 6h3v1h-3zM28 6h3v1h-3zM4 7h2v1h-2zM28 7h2v1h-2zM1 9h2v1h-2zM31 9h2v1h-2zM1 10h2v1h-2zM31 10h2v1h-2zM4 11h1v1h-1zM29 11h1v1h-1zM3 13h2v1h-2zM29 13h2v1h-2zM2 14h3v1h-3zM29 14h3v1h-3zM1 15h2v1h-2zM31 15h2v1h-2z"
        fill="#fcc405"
        shapeRendering="crispEdges"
      />
    </svg>
  );
}

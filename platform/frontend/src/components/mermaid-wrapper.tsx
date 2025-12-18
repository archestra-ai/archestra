"use client";

import dynamic from "next/dynamic";

type MermaidDiagramSkeletonProps = {
  /** Tailwind height class to align with the container height. */
  heightClass?: string;
};

const MermaidDiagramSkeleton = ({
  heightClass = "h-80",
}: MermaidDiagramSkeletonProps) => (
  <div
    role="status"
    aria-busy="true"
    aria-label="Loading diagram"
    className={`w-full ${heightClass} bg-muted/20 rounded-lg animate-pulse flex items-center justify-center`}
  >
    <div className="space-y-2 w-full px-4">
      <div className="h-4 bg-muted rounded w-3/4"></div>
      <div className="h-4 bg-muted rounded w-1/2"></div>
    </div>
  </div>
);

export const MermaidDiagram = dynamic(
  () => import("./mermaid-diagram").then((mod) => mod.MermaidDiagram),
  {
    ssr: false,
    loading: () => <MermaidDiagramSkeleton />, // Default height keeps space reserved to avoid CLS
  },
);

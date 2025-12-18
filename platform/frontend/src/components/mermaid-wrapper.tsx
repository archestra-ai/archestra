"use client";

import dynamic from "next/dynamic";

const MermaidDiagramSkeleton = () => (
  <div className="w-full h-80 bg-muted/20 rounded-lg animate-pulse flex items-center justify-center">
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
    loading: () => <MermaidDiagramSkeleton />,
  },
);

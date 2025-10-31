"use client";

import dynamic from "next/dynamic";

export const MermaidDiagram = dynamic(
  () => import("./mermaid-diagram").then((mod) => mod.MermaidDiagram),
  {
    ssr: false,
    loading: () => (
      <div className="flex justify-center p-8">Loading diagram...</div>
    ),
  },
);

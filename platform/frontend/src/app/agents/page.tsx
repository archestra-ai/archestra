"use client";

import { AgentsCanvasView } from "@/components/agents-canvas/agents-canvas-view";

export default function AgentsPage() {
  return (
    <div className="w-full h-full">
      <span id="chunk-test" style={{ visibility: "hidden" }}>
        {" "}
      </span>
      <AgentsCanvasView />
    </div>
  );
}

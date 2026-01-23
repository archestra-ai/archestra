"use client";

// Non-user-facing build marker to test chunk hashing during deployments
const _BUILD_TEST_MARKER = "chunk-hash-test-20260123";
void _BUILD_TEST_MARKER;

import { AgentsCanvasView } from "@/components/agents-canvas/agents-canvas-view";

export default function AgentsPage() {
  return <AgentsCanvasView />;
}

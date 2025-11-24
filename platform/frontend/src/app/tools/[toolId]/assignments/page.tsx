"use client";

import { ToolAssignmentsPanel } from "../../_parts/tool-assignments-panel";
import { ToolDetailShell } from "../../_parts/tool-detail-shell";
import type { Tool } from "../../_parts/types";

export default function ToolAssignmentsPage({
  params,
}: {
  params: { toolId: string };
}) {
  const { toolId } = params;

  return (
    <ToolDetailShell toolId={toolId}>
      {(tool: Tool) => <ToolAssignmentsPanel tool={tool} />}
    </ToolDetailShell>
  );
}

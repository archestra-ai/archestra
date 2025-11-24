"use client";

import { ToolDetailShell } from "../../_parts/tool-detail-shell";
import { ToolPoliciesPanel } from "../../_parts/tool-policies-panel";
import type { Tool } from "../../_parts/types";

export default function ToolPoliciesPage({
  params,
}: {
  params: { toolId: string };
}) {
  const { toolId } = params;

  return (
    <ToolDetailShell toolId={toolId}>
      {(tool: Tool) => <ToolPoliciesPanel tool={tool} />}
    </ToolDetailShell>
  );
}

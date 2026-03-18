"use client";

import { ShieldX } from "lucide-react";
import { useState } from "react";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
} from "@/components/ai-elements/tool";
import type { PolicyDeniedPart } from "@/components/message-thread";
import { EditPolicyDialog } from "./edit-policy-dialog";
import { ToolStatusRow } from "./tool-status-row";

// Re-export for backward compatibility
export type { PolicyDeniedPart as PolicyDeniedResult };

type PolicyDeniedToolProps = {
  policyDenied: PolicyDeniedPart;
} & (
  | { editable: true; profileId: string }
  | { editable?: false; profileId?: never }
);

export function PolicyDeniedTool({
  policyDenied,
  profileId,
  editable,
}: PolicyDeniedToolProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);

  // Parse errorText JSON: { method, args, reason }
  let reason = "Policy denied";
  try {
    const parsed = JSON.parse(policyDenied.errorText);
    reason = parsed.reason || reason;
  } catch {
    // Use default if not valid JSON
  }

  const hasInput = Object.keys(policyDenied.input ?? {}).length > 0;
  const toolName = policyDenied.type.replace("tool-", "");

  return (
    <>
      <Tool defaultOpen={true}>
        <ToolHeader
          type={policyDenied.type as `tool-${string}`}
          state="output-denied"
          isCollapsible={true}
        />
        <ToolContent>
          {hasInput ? <ToolInput input={policyDenied.input} /> : null}
          <ToolStatusRow
            icon={
              <ShieldX className="mt-0.5 size-4 flex-none text-destructive" />
            }
            title="Rejected"
            description={reason}
            actions={
              editable
                ? [
                    {
                      label: "Edit policy",
                      onClick: () => setIsModalOpen(true),
                      variant: "secondary" as const,
                    },
                  ]
                : []
            }
          />
        </ToolContent>
      </Tool>
      {editable && (
        <EditPolicyDialog
          open={isModalOpen}
          onOpenChange={setIsModalOpen}
          toolName={toolName}
          profileId={profileId}
        />
      )}
    </>
  );
}

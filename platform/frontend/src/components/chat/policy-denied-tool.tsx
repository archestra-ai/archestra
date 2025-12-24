"use client";

import { X } from "lucide-react";
import { useState } from "react";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
} from "@/components/ai-elements/tool";
import { PermissionButton } from "@/components/ui/permission-button";
import { EditPolicyDialog } from "./edit-policy-dialog";

export interface PolicyDeniedResult {
  type: string;
  state: "output-denied";
  input: Record<string, unknown>;
  errorText: string;
}

type PolicyDeniedToolProps = {
  policyDenied: PolicyDeniedResult;
} & (
  | { editable: true; agentId: string }
  | { editable?: false; agentId?: never }
);

export function PolicyDeniedTool({
  policyDenied,
  agentId,
  editable,
}: PolicyDeniedToolProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);

  // Parse the errorText to get the reason
  let reason = "Policy denied";
  try {
    const errorDetails = JSON.parse(policyDenied.errorText);
    reason = errorDetails.reason || reason;
  } catch {
    // Use default reason
  }

  const hasInput =
    policyDenied.input && Object.keys(policyDenied.input).length > 0;
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
          <div className="p-4 pt-0">
            <div className="flex items-start gap-2 text-sm">
              <X className="flex-none size-4 h-[1.43em] text-destructive" />
              <span className="text-destructive">Rejected: {reason}</span>
              {editable && (
                <PermissionButton
                  size="sm"
                  variant="secondary"
                  className="mt-[-0.45em]"
                  permissions={{ policy: ["update"] }}
                  onClick={() => setIsModalOpen(true)}
                >
                  Edit policy
                </PermissionButton>
              )}
            </div>
          </div>
        </ToolContent>
      </Tool>
      {editable && (
        <EditPolicyDialog
          open={isModalOpen}
          onOpenChange={setIsModalOpen}
          toolName={toolName}
          agentId={agentId}
        />
      )}
    </>
  );
}

"use client";

import { X } from "lucide-react";
import { useState } from "react";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
} from "@/components/ai-elements/tool";
import type { PolicyDeniedPart } from "@/components/chatbot-demo";
import { PermissionButton } from "@/components/ui/permission-button";
import { EditPolicyDialog } from "./edit-policy-dialog";

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
          profileId={profileId}
        />
      )}
    </>
  );
}

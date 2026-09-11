"use client";

import { CheckCircleIcon, ClockIcon } from "lucide-react";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
} from "@/components/ai-elements/tool";
import type { ChatMcpElicitationRequest } from "./mcp-elicitation-dialog";
import { ToolStatusRow } from "./tool-status-row";

export type ApprovalResponse = {
  id: string;
  action: "accept" | "decline" | "cancel";
  content?: Record<string, string | number | boolean | string[]>;
};

export function McpApprovalCard({
  request,
  isSubmitting,
  onRespond,
}: {
  request: ChatMcpElicitationRequest;
  isSubmitting: boolean;
  onRespond: (response: ApprovalResponse) => Promise<void>;
}) {
  const toolName = request.approval?.toolName ?? request.toolName;
  return (
    <Tool open>
      <ToolHeader
        type={`tool-${toolName}`}
        state="approval-requested"
        isCollapsible={false}
      />
      <ToolContent>
        <div className="border-b bg-amber-50/50 px-5 py-4 dark:bg-amber-950/20">
          <p className="text-lg font-semibold text-foreground">
            Your approval is required
          </p>
          <p className="mt-2 text-base leading-7 text-foreground">
            {request.approval?.currentTrust &&
            request.approval?.requiredTrust ? (
              <>
                This session’s trust is{" "}
                <strong>{request.approval.currentTrust}</strong>, but this
                action requires{" "}
                <strong>{request.approval.requiredTrust}</strong>. Approve to
                allow this specific action despite the lower trust level.
              </>
            ) : (
              (request.approval?.reason ??
              "Review this action and approve it to continue.")
            )}
          </p>
          {request.approval?.currentTrust ? (
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Approval applies only to this request. It does not raise the
              session’s trust.
            </p>
          ) : null}
        </div>
        <ToolInput
          input={request.approval?.input ?? { review: request.message }}
        />
        {request.approval ? (
          <details className="px-3 pb-3 text-xs text-muted-foreground">
            <summary className="cursor-pointer">Policy details</summary>
            <p className="mt-2 whitespace-pre-wrap break-words">
              {request.message}
            </p>
          </details>
        ) : null}
        <ToolStatusRow
          icon={
            <ClockIcon className="mt-0.5 size-4 flex-none text-amber-600" />
          }
          title="Review decision"
          description="Approve this request or decline to keep it blocked."
          actions={[
            {
              label: "Approve",
              variant: "secondary",
              icon: <CheckCircleIcon className="size-4" />,
              disabled: isSubmitting,
              onClick: () =>
                void onRespond({
                  id: request.id,
                  action: "accept",
                  content: {},
                }),
            },
            {
              label: "Decline",
              variant: "outline",
              disabled: isSubmitting,
              onClick: () =>
                void onRespond({ id: request.id, action: "decline" }),
            },
          ]}
        />
      </ToolContent>
    </Tool>
  );
}

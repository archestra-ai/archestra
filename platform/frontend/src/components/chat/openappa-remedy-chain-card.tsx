"use client";

import {
  type ArchestraToolShortName,
  TOOL_GET_REMEDY_PLANS_SHORT_NAME,
} from "@archestra/shared";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import { CheckCircleIcon, ClockIcon } from "lucide-react";
import {
  SectionLabel,
  Tool,
  ToolContent,
  ToolErrorDetails,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import {
  getHumanRulingDisplay,
  getToolErrorText,
  getToolHeaderState,
} from "@/lib/chat/chat-tools-display.utils";
import { useArchestraMcpIdentity } from "@/lib/mcp/archestra-mcp-server";
import { getToolCardTitle } from "./chat-messages.utils";
import {
  getRemedyChainStatus,
  type RemedyChain,
  type RemedyChainMember,
} from "./openappa-remedy-chains";
import { withoutProxyTransportArguments } from "./proxy-transport-arguments";
import { ToolStatusRow } from "./tool-status-row";

type ToolApprovalResponse = (params: {
  id: string;
  approved: boolean;
  reason?: string;
}) => void;

/**
 * A guarded call the model has not (yet) released, as one card of its
 * target tool: the Request, then the Guardrails negotiation so far. A
 * released call renders as its attempt's own tool card instead, with
 * `RemedyGuardrailsSteps` in its nested slot. `collapsible` renders it as a
 * standalone message card; otherwise it is the always-open card under a
 * compact circle.
 */
export function RemedyChainCard({
  chain,
  collapsible = false,
  canExpandToolCalls = true,
  turnActive = false,
  onToolApprovalResponse,
}: {
  chain: RemedyChain;
  collapsible?: boolean;
  /** Its turn is still running: the header reads Running, like the peel. */
  turnActive?: boolean;
  canExpandToolCalls?: boolean;
  onToolApprovalResponse?: ToolApprovalResponse;
}) {
  const status = getRemedyChainStatus(chain, { turnActive });
  const input = chain.targetArguments;
  const hasInput =
    typeof input === "object" &&
    input !== null &&
    Object.keys(input).length > 0;
  const needsAction = chain.steps.some(
    (step) => step.part.state === "approval-requested",
  );

  return (
    <Tool
      open={collapsible ? undefined : true}
      defaultOpen={collapsible ? needsAction : undefined}
      className={collapsible ? "cursor-pointer" : undefined}
    >
      <ToolHeader
        type={`tool-${chain.targetToolName}`}
        title={getToolCardTitle(chain.targetToolName)}
        state={
          status.state === "running"
            ? "input-available"
            : status.state === "error"
              ? "output-error"
              : status.state === "completed"
                ? "output-available"
                : "output-denied"
        }
        statusLabel={status.label}
        isCollapsible={collapsible && (canExpandToolCalls || needsAction)}
      />
      <ToolContent>
        {hasInput ? <ToolInput input={input} /> : null}
        <RemedyGuardrailsSteps
          steps={chain.steps}
          onToolApprovalResponse={onToolApprovalResponse}
        />
      </ToolContent>
    </Tool>
  );
}

/**
 * The Guardrails negotiation of one guarded call — notices and remedies in
 * order, each a collapsed, display-only tool card like subagent calls.
 */
export function RemedyGuardrailsSteps({
  steps,
  onToolApprovalResponse,
}: {
  steps: RemedyChainMember[];
  onToolApprovalResponse?: ToolApprovalResponse;
}) {
  const { getToolShortName } = useArchestraMcpIdentity();
  return (
    <div className="pt-2 space-y-1.5">
      <div className="px-3">
        <SectionLabel accent="bg-orange-400">Guardrails</SectionLabel>
      </div>
      <div className="px-3 space-y-1">
        {steps.map((step) => (
          <RemedyStepCard
            key={step.part.toolCallId ?? step.partIndex}
            step={step}
            getToolShortName={getToolShortName}
            onToolApprovalResponse={onToolApprovalResponse}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * A denial notice carries the blocked call's arguments in their wire form.
 * When that form is a JSON string, show the object it holds.
 */
export function withParsedArguments(
  input: ToolUIPart["input"],
): ToolUIPart["input"] {
  if (typeof input !== "object" || input === null) return input;
  const { arguments: args } = input as { arguments?: unknown };
  if (typeof args !== "string") return input;
  try {
    return {
      ...(input as Record<string, unknown>),
      arguments: JSON.parse(args),
    };
  } catch {
    return input;
  }
}

// === Internal helpers ===

/** A negotiation step, collapsed by default and display-only like subagent calls. */
function RemedyStepCard({
  step,
  getToolShortName,
  onToolApprovalResponse,
}: {
  step: RemedyChainMember;
  getToolShortName: (toolName: string) => ArchestraToolShortName | null;
  onToolApprovalResponse?: ToolApprovalResponse;
}) {
  const { part, toolResultPart, toolName } = step;
  const shortName = getToolShortName(toolName);
  const errorText = getToolErrorText({ part, toolResultPart });
  const humanRuling = getHumanRulingDisplay({ part, toolResultPart });
  const input = withoutProxyTransportArguments({
    toolName,
    shortName,
    input:
      shortName === TOOL_GET_REMEDY_PLANS_SHORT_NAME
        ? withParsedArguments(part.input)
        : part.input,
  });
  const output = toolResultPart?.output ?? part.output;
  const hasInput =
    typeof input === "object" &&
    input !== null &&
    Object.keys(input).length > 0;

  return (
    <Tool
      className="cursor-pointer"
      defaultOpen={part.state === "approval-requested"}
    >
      <ToolHeader
        type={`tool-${toolName}`}
        state={
          humanRuling?.ruling === "deny"
            ? "output-denied"
            : getToolHeaderState({
                state: part.state || "input-available",
                toolResultPart,
                errorText,
              })
        }
        statusLabel={humanRuling?.label}
      />
      <ToolContent>
        {hasInput ? <ToolInput input={input} /> : null}
        <ApprovalRow
          part={part}
          onToolApprovalResponse={onToolApprovalResponse}
        />
        {errorText ? <ToolErrorDetails errorText={errorText} /> : null}
        {output !== undefined ? (
          <ToolOutput
            label={errorText ? "Error" : "Result"}
            output={output}
            errorText={errorText}
          />
        ) : null}
      </ToolContent>
    </Tool>
  );
}

/** The approval prompt a member waiting on the user keeps inside the merged card. */
function ApprovalRow({
  part,
  onToolApprovalResponse,
}: {
  part: ToolUIPart | DynamicToolUIPart;
  onToolApprovalResponse?: ToolApprovalResponse;
}) {
  if (
    part.state !== "approval-requested" ||
    !onToolApprovalResponse ||
    !("approval" in part) ||
    !part.approval?.id
  ) {
    return null;
  }
  const approvalId = part.approval.id;
  return (
    <ToolStatusRow
      icon={<ClockIcon className="mt-0.5 size-4 flex-none text-amber-600" />}
      title="Approval required"
      description="Review this tool call before it can continue."
      actions={[
        {
          label: "Approve",
          variant: "secondary",
          icon: <CheckCircleIcon className="size-4" />,
          onClick: () =>
            onToolApprovalResponse({ id: approvalId, approved: true }),
        },
        {
          label: "Decline",
          variant: "outline",
          onClick: () =>
            onToolApprovalResponse({
              id: approvalId,
              approved: false,
              reason: "User denied",
            }),
        },
      ]}
    />
  );
}

import { extractMcpExecutedAs } from "@archestra/shared";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import { ExecutedAsBadge } from "@/components/executed-as-badge";
import { OpenAppaIcon } from "@/components/openappa-icon";
import { useSession } from "@/lib/auth/auth.query";
import {
  getToolHeaderState,
  hasToolRequest,
} from "@/lib/chat/chat-tools-display.utils";
import { getToolCardTitle } from "./chat-messages.utils";
import {
  BLOCKED_ATTEMPT_LABEL,
  type BlockedAttempt,
} from "./openappa-blocked-attempt";

/**
 * One card for a call the policy blocked: the tool the model called, the
 * arguments it sent, a Blocked state, and what the model got back for it:
 * the notice call's result, shown as returned. The card names whose identity
 * the notice call ran as. The notice's own arguments repeat the attempt and
 * the ruling, so they are not shown.
 */
export function BlockedAttemptCard({
  attempt,
  notice,
  turnActive = false,
  open = true,
  onOpenChange,
  isCollapsible = false,
  className,
}: {
  attempt: BlockedAttempt;
  /** The denial notice: the stored call the attempt was read from. */
  notice: {
    part: ToolUIPart | DynamicToolUIPart;
    toolResultPart: ToolUIPart | DynamicToolUIPart | null;
    errorText: string | undefined;
  };
  /** The notice's turn is still running, so it reads as running until it settles. */
  turnActive?: boolean;
  /** Under a circle the card is open. On its own it opens and closes like any card. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  isCollapsible?: boolean;
  className?: string;
}) {
  const { data: session } = useSession();
  const output = notice.toolResultPart
    ? notice.toolResultPart.output
    : notice.part.output;
  const executedAs = extractMcpExecutedAs(output);
  const noticeState = getToolHeaderState({
    state: notice.part.state || "input-available",
    toolResultPart: notice.toolResultPart,
    errorText: notice.errorText,
    output,
    turnActive,
  });
  // The attempt is blocked once the notice has delivered the ruling. Until
  // then, and when the notice call itself failed, it follows the notice.
  const isBlocked = noticeState === "output-available";

  return (
    <Tool open={open} onOpenChange={onOpenChange} className={className}>
      <ToolHeader
        type={`tool-${attempt.toolName}`}
        title={getToolCardTitle(attempt.toolName)}
        state={isBlocked ? "output-denied" : noticeState}
        statusLabel={isBlocked ? BLOCKED_ATTEMPT_LABEL : undefined}
        isCollapsible={isCollapsible}
        identityBadge={
          executedAs ? (
            <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              Called as
              <ExecutedAsBadge
                executedAs={executedAs}
                meUserId={session?.user?.id}
              />
            </span>
          ) : undefined
        }
      />
      <ToolContent>
        {hasToolRequest(attempt.input) ? (
          <ToolInput input={attempt.input} defaultOpen />
        ) : null}
        {notice.errorText ? (
          <ToolOutput
            label="Error"
            output={output}
            errorText={notice.errorText}
          />
        ) : (
          // The notice call's result, as the model got it for this call. It
          // is the ruling only once the notice delivered it: a stopped notice
          // carries the stop's own text.
          <ToolOutput
            label={isBlocked ? BLOCKED_ATTEMPT_LABEL : "Result"}
            labelIcon={
              isBlocked ? (
                <OpenAppaIcon className="size-3.5 text-orange-400" />
              ) : undefined
            }
            output={output}
            wrapLongLines
          />
        )}
      </ToolContent>
    </Tool>
  );
}

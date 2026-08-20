import { InlineTag } from "@/components/ui/inline-tag";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * Where the viewer's default agent comes from: a pin they made themselves, or
 * the organization's default standing in because they made none.
 */
export type DefaultAgentSource = "me" | "org";

const COPY: Record<DefaultAgentSource, { tag: string; tooltip: string }> = {
  me: {
    tag: "default (me)",
    tooltip:
      "The agent you pinned — preselected when you start a new chat, ahead of the organization default.",
  },
  org: {
    tag: "default (org)",
    tooltip:
      "Your organization's default agent — preselected because you have not pinned one of your own.",
  },
};

/**
 * Which single agent in a list is the viewer's default, and why.
 *
 * Two separate questions, and conflating them is what made this confusing:
 *
 * - WHICH agent follows the chat resolver's precedence, minus the rungs a
 *   list cannot show: a personal pin outranks the organization default, and
 *   nothing below it is badged — the seeded personal assistant is a fallback,
 *   not a default anyone chose, and calling it one is what let an
 *   organization default go unnoticed. Null when neither is configured, so no
 *   row is badged at all.
 * - WHY is identity, not precedence: the organization's default reads as the
 *   organization's whether or not this member also pinned it. Someone who
 *   pins the agent their organization already defaults to has not made it
 *   personally theirs, and a row calling that "default (me)" invites them to
 *   unpin something that would go on starting their chats regardless.
 *
 * A pin on the organization default is kept, not discarded — it is what keeps
 * that agent theirs if an admin later points the organization elsewhere, and
 * the row starts reading `default (me)` at exactly that moment.
 */
export function resolveDefaultAgentBadge(params: {
  personalDefaultAgentId?: string | null;
  organizationDefaultAgentId?: string | null;
}): { agentId: string; source: DefaultAgentSource } | null {
  const agentId =
    params.personalDefaultAgentId ?? params.organizationDefaultAgentId;
  if (!agentId) return null;

  return {
    agentId,
    source: agentId === params.organizationDefaultAgentId ? "org" : "me",
  };
}

/**
 * Whether a row offers to pin/unpin the viewer's default.
 *
 * Every chat agent does, except the one reading `default (org)`: that row
 * already says it starts their chats, so a pin there offers nothing they can
 * see, and an unpin would take away nothing — the organization default goes
 * on applying either way. The action appears the moment that stops being
 * true, when an admin points the organization default elsewhere.
 */
export function offersDefaultPin(params: {
  agentId: string;
  badge: { agentId: string; source: DefaultAgentSource } | null;
}): boolean {
  const { agentId, badge } = params;
  return !(badge?.source === "org" && badge.agentId === agentId);
}

/**
 * Marks the ONE agent that starts this viewer's new chats. Exactly one row in
 * a list may carry it: only one agent can be the default at a time, so
 * badging both a personal pin and the organization default would show two
 * answers to a question that has one — and leave the reader to work out which
 * of them actually applies. The pin wins when there is one, and the tag says
 * which case this is rather than leaving it to be inferred from the scope.
 *
 * Deliberately a tier below the scope pill beside it: it is an attribute of
 * the row for this viewer, not a classification of the agent — the same muted,
 * borderless tag the model lists use for "default".
 */
export function DefaultAgentTag({ source }: { source: DefaultAgentSource }) {
  const { tag, tooltip } = COPY[source];
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <InlineTag className="text-muted-foreground bg-muted cursor-help">
            {tag}
          </InlineTag>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

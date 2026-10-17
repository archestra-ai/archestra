"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { Bot, Database, KeyRound, Layers } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { describeKey } from "@/components/virtual-key-badge";
import { cn } from "@/lib/utils/tailwind";
import { AgentIdenticon } from "./hue-avatar";
import { isKnowledgeSource, type LogSession } from "./logs-table-format";

type AgentOption = Pick<
  archestraApiTypes.GetAgentOptionsResponses["200"]["data"][number],
  "id" | "name" | "agentType"
>;

/**
 * The agent (or LLM proxy) a session ran on, then the virtual key it
 * authenticated with — naming the key is the point, since a shared key is
 * otherwise only "no user".
 */
export function AgentCell({
  session,
  agent,
}: {
  session: LogSession;
  agent: AgentOption | undefined;
}) {
  const isKnowledge = isKnowledgeSource(session.source);
  const isDeleted =
    !agent &&
    !isKnowledge &&
    session.profileId === null &&
    !session.profileName;
  const agentName =
    agent?.name ??
    session.profileName ??
    (isKnowledge
      ? "Knowledge base"
      : session.profileId === null
        ? "Deleted LLM proxy"
        : "Unknown agent");
  const kind = agentKind({ session, agent, isKnowledge });

  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="shrink-0">
            <AgentIdenticon
              seed={session.profileId ?? agentName}
              name={agentName}
              variant={
                isDeleted ? "deleted" : isKnowledge ? "knowledge" : "agent"
              }
            />
          </span>
        </TooltipTrigger>
        <TooltipContent>
          <span>
            {isDeleted
              ? `${AGENT_KINDS[kind].label} (deleted)`
              : AGENT_KINDS[kind].label}
          </span>
        </TooltipContent>
      </Tooltip>
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "truncate text-sm leading-5 font-medium",
            isDeleted && "font-normal text-muted-foreground",
          )}
          title={agentName}
        >
          {agentName}
        </div>
        <KeyLine session={session} kind={kind} />
      </div>
    </div>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

type AgentKind = "agent" | "proxy" | "knowledge";

const AGENT_KINDS: Record<AgentKind, { icon: typeof Bot; label: string }> = {
  agent: { icon: Bot, label: "Agent" },
  proxy: { icon: Layers, label: "LLM proxy" },
  knowledge: { icon: Database, label: "Knowledge base" },
};

function agentKind({
  session,
  agent,
  isKnowledge,
}: {
  session: LogSession;
  agent: AgentOption | undefined;
  isKnowledge: boolean;
}): AgentKind {
  if (isKnowledge) return "knowledge";
  if (agent) return agent.agentType === "agent" ? "agent" : "proxy";
  // Before the agent options load (or once the agent is gone), chat and
  // ChatOps traffic can only have come from an agent.
  const source = session.source;
  return session.profileId !== null &&
    (source === "chat" || Boolean(source?.startsWith("chatops:")))
    ? "agent"
    : "proxy";
}

function KeyLine({ session, kind }: { session: LogSession; kind: AgentKind }) {
  const keys = session.virtualKeys ?? [];
  if (keys.length === 0) {
    const KindIcon = AGENT_KINDS[kind].icon;
    return (
      <div className="flex h-4 min-w-0 items-center gap-1 text-xs leading-4 text-muted-foreground">
        <KindIcon className="size-3 shrink-0 opacity-70" aria-hidden="true" />
        <span className="truncate">{AGENT_KINDS[kind].label}</span>
      </div>
    );
  }
  const [first] = keys;
  const sharedScope = first.scope === "personal" ? null : first.scope;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <UnstyledButton className="flex h-4 max-w-full min-w-0 cursor-default items-center gap-1 text-left text-xs leading-4 text-muted-foreground hover:text-foreground">
          <KeyRound className="size-3 shrink-0 opacity-70" aria-hidden="true" />
          <span className="truncate font-mono text-[11px]">{first.name}</span>
          {sharedScope ? (
            <span className="shrink-0 rounded-[4px] bg-muted px-1 text-[10px] leading-[14px] text-muted-foreground">
              {sharedScope}
            </span>
          ) : null}
          {keys.length > 1 ? (
            <span className="shrink-0 tabular-nums">+{keys.length - 1}</span>
          ) : null}
        </UnstyledButton>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs px-2 py-1.5">
        <div className="space-y-1.5">
          {keys.map((key) => (
            <div key={key.id}>
              <div className="flex items-center gap-1.5 font-medium">
                <KeyRound
                  className="size-3 text-muted-foreground"
                  aria-hidden="true"
                />
                <span>{key.name}</span>
              </div>
              <div className="pl-[18px] text-muted-foreground">
                {describeKey(key)} · {key.tokenStart}…
              </div>
            </div>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

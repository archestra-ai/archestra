"use client";

import type { AgentType } from "@archestra/shared";
import Link from "next/link";
import type { ReactNode } from "react";
import { AgentIcon } from "@/components/agent-icon";
import {
  agentAction,
  getAgentActionModel,
} from "@/components/agent-pages/agent-actions-model";
import { agentDetailHref } from "@/components/agent-pages/agent-page-config";
import { RuntimeCapableIndicator } from "@/components/chat/runtime-capable-indicator";
import { type PinnedTile, PinnedTiles } from "@/components/pinned-tiles";
import { Button } from "@/components/ui/button";
import { useProfile } from "@/lib/agent.query";
import { useFeature } from "@/lib/config/config.query";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";

/** What a tile needs of an agent, whichever read it came from. */
interface PinnableAgent {
  id: string;
  name: string;
  icon?: string | null;
  description?: string | null;
  agentType: AgentType;
  builtIn?: boolean | null;
  runtime?: Parameters<typeof RuntimeCapableIndicator>[0]["runtime"] | null;
  lastUsedAt?: string | null;
}

/**
 * The agents page's pinned tiles: the ones you pinned, plus the ones pinned
 * for you — your default agent, your personal chat agent and the
 * organization's default — each saying why. Those three are not stored pins;
 * they follow the settings that make them, so they cannot be unpinned here.
 */
export function AgentPinnedTiles({
  pinned,
  inView,
  pinnedFor,
  onUnpin,
  isLoading,
  renderMenu,
}: {
  /** Agents the viewer pinned, newest pin first. */
  pinned: PinnableAgent[];
  /** Agents on the list's current page, which carry when each was last used. */
  inView: PinnableAgent[];
  /** Agents pinned for the viewer, with why, in display order. */
  pinnedFor: Array<{ id: string; reasons: string[] }>;
  onUnpin: (agent: PinnableAgent) => void;
  isLoading: boolean;
  /** The "More actions" menu for one tile, by id. */
  renderMenu?: (id: string) => ReactNode;
}) {
  const runtimeEnabled = useFeature("agentRuntime") === true;
  const automatic = useAutomaticAgents(pinnedFor.map(({ id }) => id));
  // List rows first: a single-agent read does not say when it was last used.
  const known = new Map(
    [...inView, ...pinned].map((agent) => [agent.id, agent]),
  );
  for (const agent of automatic)
    if (!known.has(agent.id)) known.set(agent.id, agent);

  const reasonsFor = new Map(pinnedFor.map(({ id, reasons }) => [id, reasons]));
  const order = [
    ...pinnedFor.map(({ id }) => id),
    ...pinned.map(({ id }) => id).filter((id) => !reasonsFor.has(id)),
  ];
  const tiles: PinnedTile[] = order.flatMap((id) => {
    const agent = known.get(id);
    if (!agent) return [];
    const reasons = reasonsFor.get(id);
    const chat = agentAction(
      getAgentActionModel({
        kind: "agent",
        agent,
        agentRuntimeEnabled: runtimeEnabled,
      }),
      "chat",
    );
    return [
      {
        id,
        name: agent.name,
        href: agentDetailHref("agent", id),
        icon: <AgentIcon icon={agent.icon} size={18} />,
        status:
          agent.lastUsedAt !== undefined
            ? `Last used ${formatRelativeTimeFromNow(agent.lastUsedAt ?? null, {
                neverLabel: "never",
                strict: true,
              })}`
            : (agent.description ?? ""),
        kind:
          runtimeEnabled && agent.runtime ? (
            <RuntimeCapableIndicator variant="pill" runtime={agent.runtime} />
          ) : undefined,
        pinnedBecause: reasons,
        action:
          chat.visible && chat.href ? (
            <Button size="sm" asChild>
              <Link href={chat.href}>{chat.label}</Link>
            </Button>
          ) : undefined,
        // A pin the viewer made, on an agent that is not also pinned for
        // them, is theirs to take back.
        menu: renderMenu?.(id),
        onUnpin:
          reasons || !pinned.some((candidate) => candidate.id === id)
            ? undefined
            : () => onUnpin(agent),
      },
    ];
  });

  return <PinnedTiles tiles={tiles} isLoading={isLoading} />;
}

/**
 * The agents pinned for the viewer, read one by one: at most three, and they
 * are seldom on the page of the list already in view.
 */
function useAutomaticAgents(ids: string[]): PinnableAgent[] {
  const first = useProfile(ids[0]);
  const second = useProfile(ids[1]);
  const third = useProfile(ids[2]);
  return [first.data, second.data, third.data].flatMap((agent) =>
    agent ? [agent as PinnableAgent] : [],
  );
}

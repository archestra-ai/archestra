"use client";

import type { AgentType } from "@archestra/shared";
import type { ReactNode } from "react";
import { AgentIcon } from "@/components/agent-icon";
import {
  agentAction,
  getAgentActionModel,
} from "@/components/agent-pages/agent-actions-model";
import { agentDetailHref } from "@/components/agent-pages/agent-page-config";
import { IntentPrefetchLink } from "@/components/intent-prefetch-link";
import { type PinnedTile, PinnedTiles } from "@/components/pinned-tiles";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useDefaultMcpGateway, useProfile } from "@/lib/agent.query";
import { useOrganization } from "@/lib/organization.query";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { type GatewayToolRow, gatewayToolNames } from "./gateway-tools";

/** What a tile needs of a gateway, whichever read it came from. */
interface PinnableGateway {
  id: string;
  name: string;
  icon?: string | null;
  description?: string | null;
  agentType: AgentType;
  builtIn?: boolean | null;
  lastUsedAt?: string | null;
  /** Exposes every tool the caller can reach, not just assigned ones. */
  accessAllTools: boolean;
  tools: GatewayToolRow[];
}

/**
 * Gateways pinned for the viewer without their pinning them, with why: their
 * personal gateway, and the one the Connect page starts on. The page's table
 * leaves these out, since they are tiles. `isLoading` holds while either is
 * still unknown, so the page does not list one as a row first.
 */
export function useGatewaysPinnedForViewer(): {
  pins: Array<{ id: string; reasons: string[] }>;
  isLoading: boolean;
} {
  const { data: personalGateway, isLoading: isPersonalGatewayLoading } =
    useDefaultMcpGateway();
  const { data: organization, isLoading: isOrganizationLoading } =
    useOrganization();
  const personalGatewayId = personalGateway?.id ?? null;
  // The same pick the Connect page makes when nothing is chosen there.
  const connectDefaultId =
    organization?.connectionDefaultMcpGatewayId ?? personalGatewayId;
  return {
    pins: collectPinReasons([
      [personalGatewayId, "Personal"],
      [connectDefaultId, "Connect default"],
    ]),
    isLoading: isPersonalGatewayLoading || isOrganizationLoading,
  };
}

/**
 * The gateways page's pinned tiles: the ones you pinned, plus the ones pinned
 * for you — your personal gateway and the one the Connect page starts on —
 * each saying why. Those two are not stored pins; they follow the settings
 * that make them, so they cannot be unpinned here.
 */
export function GatewayPinnedTiles({
  pinned,
  inView,
  onUnpin,
  isLoading,
  renderMenu,
}: {
  /** Gateways the viewer pinned, newest pin first. */
  pinned: PinnableGateway[];
  /** Gateways on the list's current page, which carry when each was last used. */
  inView: PinnableGateway[];
  onUnpin: (gateway: PinnableGateway) => void;
  isLoading: boolean;
  /** The "More actions" menu for one tile, by id. */
  renderMenu?: (id: string) => ReactNode;
}) {
  const { data: personalGateway } = useDefaultMcpGateway();
  const { pins: pinnedFor, isLoading: isPinnedForLoading } =
    useGatewaysPinnedForViewer();

  // List rows first: a single-gateway read does not say when it was last used.
  const known = new Map<string, PinnableGateway>(
    [...inView, ...pinned].map((gateway) => [gateway.id, gateway]),
  );
  if (personalGateway && !known.has(personalGateway.id))
    known.set(personalGateway.id, personalGateway);
  const automatic = useAutomaticGateways(
    pinnedFor.map(({ id }) => id).filter((id) => !known.has(id)),
  );
  for (const gateway of automatic)
    if (!known.has(gateway.id)) known.set(gateway.id, gateway);

  const reasonsFor = new Map(pinnedFor.map(({ id, reasons }) => [id, reasons]));
  const order = [
    ...pinnedFor.map(({ id }) => id),
    ...pinned.map(({ id }) => id).filter((id) => !reasonsFor.has(id)),
  ];
  const tiles: PinnedTile[] = order.flatMap((id) => {
    const gateway = known.get(id);
    if (!gateway) return [];
    const reasons = reasonsFor.get(id);
    const connect = agentAction(
      getAgentActionModel({ kind: "mcp_gateway", agent: gateway }),
      "connect",
    );
    return [
      {
        id,
        name: gateway.name,
        href: agentDetailHref("mcp_gateway", id),
        icon: (
          <AgentIcon icon={gateway.icon} size={18} fallbackType="mcp_gateway" />
        ),
        status:
          gateway.lastUsedAt !== undefined
            ? `Last used ${formatRelativeTimeFromNow(
                gateway.lastUsedAt ?? null,
                { neverLabel: "never", strict: true },
              )}`
            : (gateway.description ?? ""),
        kind: <GatewayToolsChip gateway={gateway} />,
        pinnedBecause: reasons,
        action:
          connect.visible && connect.href ? (
            <Button size="sm" asChild>
              <IntentPrefetchLink href={connect.href}>
                {connect.label}
              </IntentPrefetchLink>
            </Button>
          ) : undefined,
        // A pin the viewer made, on a gateway that is not also pinned for
        // them, is theirs to take back.
        menu: renderMenu?.(id),
        onUnpin:
          reasons || !pinned.some((candidate) => candidate.id === id)
            ? undefined
            : () => onUnpin(gateway),
      },
    ];
  });

  return (
    <PinnedTiles tiles={tiles} isLoading={isLoading || isPinnedForLoading} />
  );
}

/**
 * What the gateway exposes, decided as the list's Tools column decides it:
 * every tool the caller can reach, or a count of the ones assigned.
 */
function GatewayToolsChip({ gateway }: { gateway: PinnableGateway }) {
  if (gateway.accessAllTools) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {/* Above the tile's whole-card link, so hover reaches it. */}
          <Badge variant="outline" className="relative z-10" tabIndex={0}>
            All your tools
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-64">
          Exposes every tool you have access to.
        </TooltipContent>
      </Tooltip>
    );
  }
  const count = gatewayToolNames(gateway.tools).length;
  return (
    <Badge variant="outline">
      <span>{count === 1 ? "1 tool" : `${count} tools`}</span>
    </Badge>
  );
}

/**
 * The gateways pinned for the viewer that the list rows do not already hold,
 * read one by one: at most two.
 */
function useAutomaticGateways(ids: string[]): PinnableGateway[] {
  const first = useProfile(ids[0]);
  const second = useProfile(ids[1]);
  return [first.data, second.data].flatMap((gateway) =>
    gateway ? [gateway as PinnableGateway] : [],
  );
}

function collectPinReasons(
  entries: Array<[string | null | undefined, string]>,
): Array<{ id: string; reasons: string[] }> {
  const byId = new Map<string, string[]>();
  for (const [id, reason] of entries) {
    if (!id) continue;
    byId.set(id, [...(byId.get(id) ?? []), reason]);
  }
  return [...byId].map(([id, reasons]) => ({ id, reasons }));
}

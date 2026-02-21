"use client";

import { Bot, Pencil, X } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import Divider from "@/components/divider";
import {
  AssignmentCombobox,
  type AssignmentComboboxItem,
} from "@/components/ui/assignment-combobox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { ProviderConfig } from "./types";

function bindingLabel(b: {
  isDm?: boolean;
  channelName?: string | null;
  channelId: string;
}) {
  return b.isDm ? "Direct Messages" : (b.channelName ?? b.channelId);
}

interface Binding {
  id: string;
  channelId: string;
  channelName?: string | null;
  workspaceId?: string | null;
  workspaceName?: string | null;
  isDm?: boolean;
}

interface AgentTileProps {
  agent: {
    id: string;
    name: string;
    description?: string | null;
  };
  agentBindings: Binding[];
  channelComboboxItems: AssignmentComboboxItem[];
  assignedChannelIds: string[];
  totalChannelCount: number;
  providerConfig: ProviderConfig;
  providerStatus: {
    dmInfo?: { botUserId?: string; teamId?: string; appId?: string } | null;
  } | null;
  onToggleChannel: (bindingId: string) => void;
  onUnassignChannel: (bindingId: string) => void;
  onDmClick: (agentId: string, deepLink: string) => void;
  onEdit: () => void;
  isUpdating: boolean;
}

export function AgentTile({
  agent,
  agentBindings,
  channelComboboxItems,
  assignedChannelIds,
  totalChannelCount,
  providerConfig,
  providerStatus,
  onToggleChannel,
  onUnassignChannel,
  onDmClick,
  onEdit,
  isUpdating,
}: AgentTileProps) {
  const channelCount = agentBindings.filter((b) => !b.isDm).length;
  const dmDeepLink = providerStatus
    ? providerConfig.getDmDeepLink?.(providerStatus, agent.id)
    : null;

  const nonDmBindings = agentBindings.filter((b) => !b.isDm);
  // DM bindings shown first
  const sortedBindings = [...agentBindings].sort((a, b) =>
    a.isDm === b.isDm ? 0 : a.isDm ? -1 : 1,
  );

  return (
    <Card className="h-full overflow-hidden py-4">
      <CardContent className="flex h-full flex-col gap-3 px-4">
        {/* Top row: name + edit */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <Bot className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="text-base font-semibold truncate">
              {agent.name}
            </span>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Edit"
            onClick={onEdit}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
        </div>

        {/* Description (truncated) */}
        {agent.description && (
          <p className="text-xs text-muted-foreground line-clamp-2 -mt-1">
            {agent.description}
          </p>
        )}

        {/* Channel count label */}
        <p className="text-xs text-muted-foreground">
          Channels handled: {channelCount}/{totalChannelCount}
        </p>

        {/* Channel badges + Add combobox */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {sortedBindings.map((b) => (
            <Badge
              key={b.id}
              variant="secondary"
              className={cn(
                "text-xs pl-2 pr-1 py-0.5 gap-1",
                b.isDm && "bg-indigo-400 text-white",
              )}
            >
              <span className="truncate max-w-[140px]">{bindingLabel(b)}</span>
              <Button
                variant="ghost"
                size="icon-sm"
                className={cn(
                  "ml-0.5 h-auto w-auto rounded-full p-0.5",
                  b.isDm ? "hover:bg-white/20" : "hover:bg-muted-foreground/20",
                )}
                onClick={() => onUnassignChannel(b.id)}
                disabled={isUpdating}
                aria-label={`Remove ${bindingLabel(b)}`}
              >
                <X className="h-3 w-3" />
              </Button>
            </Badge>
          ))}
          <AssignmentCombobox
            items={channelComboboxItems}
            selectedIds={assignedChannelIds}
            onToggle={onToggleChannel}
            placeholder="Search channels..."
            emptyMessage="No channels found."
            className="h-6 px-2 gap-1 text-[10px]"
          />
        </div>

        <Divider className="mt-auto" />

        {/* Action buttons: DM → Open channel → Chat */}
        <div className="flex items-stretch gap-2">
          {dmDeepLink && (
            <Button
              variant="outline"
              size="sm"
              className="flex-1 min-w-0 text-xs h-7 truncate"
              onClick={() => onDmClick(agent.id, dmDeepLink)}
            >
              <Image
                src={providerConfig.providerIcon}
                alt={providerConfig.providerLabel}
                width={14}
                height={14}
              />
              DM
            </Button>
          )}
          {nonDmBindings.length <= 1 ? (
            <Button
              variant="outline"
              size="sm"
              className="flex-[2] min-w-0 text-xs h-7 truncate"
              disabled={nonDmBindings.length === 0}
              asChild={nonDmBindings.length === 1}
            >
              {nonDmBindings.length === 1 ? (
                <a
                  href={providerConfig.buildDeepLink(nonDmBindings[0])}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Image
                    src={providerConfig.providerIcon}
                    alt={providerConfig.providerLabel}
                    width={14}
                    height={14}
                  />
                  Open channel
                </a>
              ) : (
                <>
                  <Image
                    src={providerConfig.providerIcon}
                    alt={providerConfig.providerLabel}
                    width={14}
                    height={14}
                  />
                  Open channel
                </>
              )}
            </Button>
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-[2] min-w-0 text-xs h-7 truncate"
                >
                  <Image
                    src={providerConfig.providerIcon}
                    alt={providerConfig.providerLabel}
                    width={14}
                    height={14}
                  />
                  Open channel
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {nonDmBindings.map((b) => (
                  <DropdownMenuItem key={b.id} asChild>
                    <a
                      href={providerConfig.buildDeepLink(b)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {b.channelName ?? b.channelId}
                      {b.workspaceName ? ` (${b.workspaceName})` : ""}
                    </a>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button
            variant="outline"
            size="sm"
            className="flex-1 min-w-0 text-xs h-7 truncate"
            asChild
          >
            <Link href={`/chat/new?agent_id=${agent.id}`}>
              <Image src="/logo.png" alt="Archestra" width={14} height={14} />
              Chat
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

"use client";

import { Bot, CheckIcon, Hash, Plus, X } from "lucide-react";
import Image from "next/image";
import { useState } from "react";
import Divider from "@/components/divider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { ProviderConfig } from "./types";

interface Agent {
  id: string;
  name: string;
}

interface Binding {
  id: string;
  channelId: string;
  channelName?: string | null;
  workspaceId?: string | null;
  workspaceName?: string | null;
  isDm?: boolean;
  agentId?: string | null;
}

interface ChannelTileProps {
  binding: Binding;
  agents: Agent[];
  assignedAgent: Agent | undefined;
  providerConfig: ProviderConfig;
  providerStatus: {
    dmInfo?: { botUserId?: string; teamId?: string; appId?: string } | null;
  } | null;
  onAssignAgent: (bindingId: string, agentId: string | null) => void;
  isUpdating: boolean;
}

export function ChannelTile({
  binding,
  agents,
  assignedAgent,
  providerConfig,
  providerStatus,
  onAssignAgent,
  isUpdating,
}: ChannelTileProps) {
  const [pickerOpen, setPickerOpen] = useState(false);

  const channelLabel = binding.isDm
    ? (binding.channelName ?? "Direct Message")
    : (binding.channelName ?? binding.channelId);

  const deepLink = binding.isDm
    ? providerStatus
      ? providerConfig.getDmDeepLink?.(providerStatus)
      : null
    : providerConfig.buildDeepLink(binding);

  return (
    <Card className={`h-full overflow-hidden py-4`}>
      <CardContent className="flex h-full flex-col gap-3 px-4">
        {/* Top row: channel name + workspace */}
        <div className="flex items-center gap-2 min-w-0">
          {!binding.isDm && (
            <Hash className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          {binding.isDm ? (
            <span className="bg-linear-to-r from-purple-600 to-blue-600 bg-clip-text text-base font-semibold text-transparent">
              Direct Message
            </span>
          ) : (
            <span className="text-base font-semibold truncate">
              {channelLabel}
            </span>
          )}
          {binding.workspaceName && (
            <Badge
              variant="secondary"
              className="ml-auto shrink-0 border-indigo-500/30 bg-indigo-400/10 text-indigo-500 dark:text-indigo-400"
            >
              {binding.workspaceName}
            </Badge>
          )}
        </div>

        {/* Agent assignment */}
        <Popover open={pickerOpen} onOpenChange={setPickerOpen} modal>
          <div className="flex items-center gap-2 min-w-0 my-1">
            <span className="text-xs text-muted-foreground shrink-0">
              Default Agent:
            </span>
            {assignedAgent ? (
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1.5 border-emerald-500/30 bg-emerald-500/10 text-xs text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-400"
                  disabled={isUpdating}
                >
                  <Bot className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{assignedAgent.name}</span>
                </Button>
              </PopoverTrigger>
            ) : (
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 px-3 gap-1.5 text-xs"
                  disabled={isUpdating}
                >
                  <Plus className="h-3.5 w-3.5" />
                  Assign
                </Button>
              </PopoverTrigger>
            )}
          </div>
          <PopoverContent className="w-64 p-0" align="start">
            <Command>
              <CommandInput placeholder="Search agents..." />
              <CommandList>
                <CommandEmpty>No agents found.</CommandEmpty>
                <CommandGroup>
                  {assignedAgent && (
                    <>
                      <CommandItem
                        onSelect={() => {
                          onAssignAgent(binding.id, null);
                          setPickerOpen(false);
                        }}
                      >
                        <X className="mr-2 h-4 w-4 text-muted-foreground" />
                        <span className="text-muted-foreground">Unassign</span>
                      </CommandItem>
                      <Divider className="my-1" />
                    </>
                  )}
                  {agents.map((agent) => (
                    <CommandItem
                      key={agent.id}
                      value={agent.name}
                      onSelect={() => {
                        onAssignAgent(binding.id, agent.id);
                        setPickerOpen(false);
                      }}
                    >
                      <Bot className="mr-2 h-4 w-4" />
                      <span className="truncate">{agent.name}</span>
                      {assignedAgent?.id === agent.id && (
                        <CheckIcon className="ml-auto h-4 w-4" />
                      )}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>

        <Divider />

        {/* Footer: open in provider */}
        {deepLink && (
          <Button
            variant="outline"
            size="sm"
            className="w-full gap-2 text-xs"
            asChild
          >
            <a href={deepLink} target="_blank" rel="noopener noreferrer">
              <Image
                src={providerConfig.providerIcon}
                alt={providerConfig.providerLabel}
                width={14}
                height={14}
              />
              {binding.isDm ? "Send DM" : "Open"}
            </a>
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

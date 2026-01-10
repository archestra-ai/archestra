"use client";

import { ChevronDown } from "lucide-react";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useProfiles } from "@/lib/agent.query";
import { useUpdateConversation } from "@/lib/chat.query";

interface ProfileSelectorProps {
  currentAgentId: string;
  conversationId: string;
}

export function ProfileSelector({
  currentAgentId,
  conversationId,
}: ProfileSelectorProps) {
  const { data: profiles = [] } = useProfiles();
  const updateConversationMutation = useUpdateConversation();

  const currentProfile = useMemo(
    () => profiles.find((p) => p.id === currentAgentId),
    [profiles, currentAgentId],
  );

  const handleProfileChange = (newAgentId: string) => {
    if (newAgentId === currentAgentId) return;

    updateConversationMutation.mutate({
      id: conversationId,
      agentId: newAgentId,
    });
  };

  if (profiles.length === 0) {
    return null;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 px-3">
          <span className="text-xs font-medium">
            {currentProfile?.name || "Select Profile"}
          </span>
          <ChevronDown className="ml-2 h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[200px]">
        {profiles.map((profile) => (
          <DropdownMenuItem
            key={profile.id}
            onClick={() => handleProfileChange(profile.id)}
            className="cursor-pointer"
          >
            <span
              className={
                profile.id === currentAgentId ? "font-semibold" : "font-normal"
              }
            >
              {profile.name}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

"use client";

import { Check, ChevronDown, ChevronRight, Layers } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
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
import { useProfiles } from "@/lib/agent.query";
import { useUpdateConversation } from "@/lib/chat.query";
import { cn } from "@/lib/utils";

interface ProfileSelectorProps {
  currentAgentId: string;
  /** If provided, changing profile will update the conversation */
  conversationId?: string;
  /** If provided (and no conversationId), this callback will be called on profile change */
  onProfileChange?: (agentId: string) => void;
}

export function ProfileSelector({
  currentAgentId,
  conversationId,
  onProfileChange,
}: ProfileSelectorProps) {
  const { data: profiles = [] } = useProfiles();
  const updateConversationMutation = useUpdateConversation();
  const [open, setOpen] = useState(false);

  const currentProfile = useMemo(
    () => profiles.find((p) => p.id === currentAgentId),
    [profiles, currentAgentId],
  );

  const handleProfileChange = (newAgentId: string) => {
    if (newAgentId === currentAgentId) {
      setOpen(false);
      return;
    }

    if (conversationId) {
      // Update existing conversation
      updateConversationMutation.mutate({
        id: conversationId,
        agentId: newAgentId,
      });
    } else if (onProfileChange) {
      // Call callback for initial chat (no conversation yet)
      onProfileChange(newAgentId);
    }
    setOpen(false);
  };

  if (profiles.length === 0) {
    return null;
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-8 justify-between"
        >
          <Layers className="h-3 w-3 shrink-0 opacity-70" />
          <span className="text-xs font-medium">
            {currentProfile?.name || "Select Profile"}
          </span>
          {open ? (
            <ChevronDown className="ml-1 h-3 w-3 shrink-0 opacity-50" />
          ) : (
            <ChevronRight className="ml-1 h-3 w-3 shrink-0 opacity-50" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[200px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search profile..." className="h-9" />
          <CommandList>
            <CommandEmpty>No profile found.</CommandEmpty>
            <CommandGroup>
              {profiles.map((profile) => (
                <CommandItem
                  key={profile.id}
                  value={profile.name}
                  onSelect={() => handleProfileChange(profile.id)}
                >
                  {profile.name}
                  <Check
                    className={cn(
                      "ml-auto h-4 w-4",
                      currentAgentId === profile.id
                        ? "opacity-100"
                        : "opacity-0",
                    )}
                  />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

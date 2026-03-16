"use client";

import type { archestraApiTypes, InteractionSource } from "@shared";
import { AgentIcon } from "@/components/agent-icon";
import { SourceLabel } from "@/components/source-badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

type ProfileOption = archestraApiTypes.GetAllAgentsResponses["200"][number];

export function ProfileFilterOption({
  profile,
}: {
  profile: Pick<ProfileOption, "agentType" | "icon" | "name">;
}) {
  return (
    <span className="flex items-center gap-2 min-w-0">
      <AgentIcon
        icon={profile.icon}
        fallbackType={
          profile.agentType === "profile" ? "agent" : profile.agentType
        }
        className="text-muted-foreground"
      />
      <span className="truncate">{profile.name}</span>
    </span>
  );
}

export function SourceFilterOption({ source }: { source: InteractionSource }) {
  return (
    <span className="flex items-center min-w-0">
      <SourceLabel source={source} className="flex items-center min-w-0" />
    </span>
  );
}

export function UserFilterOption({ name }: { name: string }) {
  return (
    <span className="flex items-center gap-2 min-w-0">
      <Avatar className="h-5 w-5">
        <AvatarFallback className="text-[10px]">
          {getInitials(name)}
        </AvatarFallback>
      </Avatar>
      <span className="truncate">{name}</span>
    </span>
  );
}

function getInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);

  if (parts.length === 0) {
    return "U";
  }

  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

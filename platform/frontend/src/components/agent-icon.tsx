"use client";

import type { archestraApiTypes } from "@shared";
import { Bot, Network, Route } from "lucide-react";
import Image from "next/image";
import { cn } from "@/lib/utils";

export type AgentIconVariant = Exclude<
  archestraApiTypes.GetAgentsResponses["200"]["data"][number]["agentType"],
  "profile"
>;

interface AgentIconProps {
  icon?: string | null;
  className?: string;
  size?: number;
  fallbackType?: AgentIconVariant;
}

export function AgentIcon({
  icon,
  className,
  size = 16,
  fallbackType = "agent",
}: AgentIconProps) {
  if (!icon) {
    const FallbackIcon =
      fallbackType === "llm_proxy"
        ? Network
        : fallbackType === "mcp_gateway"
          ? Route
          : Bot;

    return (
      <FallbackIcon
        className={cn("shrink-0 opacity-70", className)}
        style={{ width: size, height: size }}
      />
    );
  }

  if (icon.startsWith("data:")) {
    return (
      <Image
        src={icon}
        alt="Agent icon"
        width={size}
        height={size}
        className={cn("shrink-0 rounded-sm object-contain", className)}
      />
    );
  }

  // Emoji
  return (
    <span
      className={cn("shrink-0 leading-none", className)}
      style={{ fontSize: size }}
    >
      {icon}
    </span>
  );
}

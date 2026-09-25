"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { Bot, Folder, Network, Route, Server } from "lucide-react";
import Image from "next/image";
import {
  getBuiltInServiceIconPath,
  isAgentImageIcon,
} from "@/components/agent-icon.utils";
import { imageToneClassName, useImageTone } from "@/lib/hooks/use-image-tone";
import { cn } from "@/lib/utils/tailwind";

export type AgentIconVariant = Exclude<
  archestraApiTypes.GetAgentsResponses["200"]["data"][number]["agentType"],
  "profile"
>;

/** Fallback glyphs supported by the shared icon display/picker. */
type IconFallbackType = AgentIconVariant | "project" | "server";

interface AgentIconProps {
  icon?: string | null;
  className?: string;
  size?: number;
  fallbackType?: IconFallbackType;
}

export function AgentIcon({
  icon,
  className,
  size = 16,
  fallbackType = "agent",
}: AgentIconProps) {
  const imageTone = useImageTone(isAgentImageIcon(icon) ? icon : null);

  if (!icon) {
    const FallbackIcon =
      fallbackType === "llm_proxy"
        ? Network
        : fallbackType === "mcp_gateway"
          ? Route
          : fallbackType === "project"
            ? Folder
            : fallbackType === "server"
              ? Server
              : Bot;

    return (
      <FallbackIcon
        className={cn("shrink-0 opacity-70", className)}
        style={{ width: size, height: size }}
      />
    );
  }

  if (isAgentImageIcon(icon)) {
    return (
      <Image
        src={icon}
        alt="Agent icon"
        width={size}
        height={size}
        className={cn(
          "shrink-0 rounded-sm object-contain",
          imageToneClassName(imageTone),
          className,
        )}
      />
    );
  }

  const servicePath = getBuiltInServiceIconPath(icon);
  if (servicePath) {
    return (
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className={cn("shrink-0", className)}
        style={{ width: size, height: size }}
        fill="currentColor"
      >
        <path d={servicePath} />
      </svg>
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

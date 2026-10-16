"use client";

import {
  AGENT_CATALOG_NAMES,
  APPA_KEEPER_AGENT_ICON,
  type archestraApiTypes,
} from "@archestra/shared";
import {
  Bot,
  Folder,
  Network,
  Puzzle,
  Route,
  Server,
  Sparkles,
} from "lucide-react";
import Image from "next/image";
import {
  getBuiltInServiceIconPath,
  getCatalogAgentId,
  isAgentImageIcon,
} from "@/components/agent-icon.utils";
import { AppaKeeperIcon } from "@/components/appa-keeper-icon";
import { ClientMarkTile } from "@/components/client-mark-tile";
import { CATALOG_AGENT_MARKS } from "@/components/client-marks";
import { OpenAppaSolidIcon } from "@/components/openappa-icon";
import { imageToneClassName, useImageTone } from "@/lib/hooks/use-image-tone";
import { cn } from "@/lib/utils/tailwind";

export type AgentIconVariant = Exclude<
  Omit<
    archestraApiTypes.GetAgentsResponses["200"]["data"][number],
    "pinnedAt"
  >["agentType"],
  "profile"
>;

/** Fallback glyphs supported by the shared icon display/picker. */
type IconFallbackType =
  | AgentIconVariant
  | "project"
  | "server"
  | "skill"
  | "plugin";

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
  const catalogId = getCatalogAgentId(icon);
  const imageTone = useImageTone(
    isAgentImageIcon(icon) && !catalogId ? icon : null,
  );

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
              : fallbackType === "skill"
                ? Sparkles
                : fallbackType === "plugin"
                  ? Puzzle
                  : Bot;

    return (
      <FallbackIcon
        className={cn("shrink-0 opacity-70", className)}
        style={{ width: size, height: size }}
      />
    );
  }

  if (catalogId) {
    return (
      <ClientMarkTile
        mark={CATALOG_AGENT_MARKS[catalogId]}
        label={AGENT_CATALOG_NAMES[catalogId]}
        size={size}
        className={className}
      />
    );
  }

  if (isAgentImageIcon(icon)) {
    // Square border box: a logo with another aspect ratio, or the tone
    // padding that arrives after the image loads, cannot resize it.
    return (
      <Image
        src={icon}
        alt="Agent icon"
        width={size}
        height={size}
        className={cn(
          "aspect-square shrink-0 rounded-sm object-contain",
          imageToneClassName(imageTone),
          className,
        )}
      />
    );
  }

  if (icon === APPA_KEEPER_AGENT_ICON) {
    return (
      <AppaKeeperIcon
        className={cn("shrink-0", className)}
        style={{ width: size, height: size }}
      />
    );
  }

  if (icon === "logo:openappa") {
    return (
      <OpenAppaSolidIcon
        className={cn("shrink-0", className)}
        style={{ width: size, height: size }}
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

  // Emoji: a fixed square box, so the emoji font's glyph width does not
  // set the width. A wider glyph stays centered and overflows the box.
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center leading-none",
        className,
      )}
      style={{ width: size, height: size, fontSize: size }}
    >
      {icon}
    </span>
  );
}

"use client";

import { Bot } from "lucide-react";
import Image from "next/image";
import { cn } from "@/lib/utils";

interface AgentIconProps {
  icon?: string | null;
  className?: string;
  size?: number;
}

export function AgentIcon({ icon, className, size = 16 }: AgentIconProps) {
  if (!icon) {
    return (
      <Bot
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

"use client";

import { ARCHESTRA_MCP_CATALOG_ID } from "@shared";
import { Server } from "lucide-react";
import Image from "next/image";
import { cn } from "@/lib/utils";

interface McpCatalogIconProps {
  icon?: string | null;
  catalogId?: string;
  size?: number;
  className?: string;
}

export function McpCatalogIcon({
  icon,
  catalogId,
  size = 20,
  className,
}: McpCatalogIconProps) {
  if (!icon && catalogId === ARCHESTRA_MCP_CATALOG_ID) {
    return (
      <Image
        src="/logo.png"
        alt="Archestra"
        width={size}
        height={size}
        className={cn("shrink-0 rounded-sm object-contain", className)}
      />
    );
  }

  if (!icon) {
    return (
      <Server
        className={cn("shrink-0 text-muted-foreground", className)}
        style={{ width: size, height: size }}
      />
    );
  }

  if (icon.startsWith("data:")) {
    return (
      <Image
        src={icon}
        alt="MCP server icon"
        width={size}
        height={size}
        className={cn("shrink-0 rounded-sm object-contain", className)}
      />
    );
  }

  return (
    <span
      className={cn("shrink-0 leading-none", className)}
      style={{ fontSize: size }}
    >
      {icon}
    </span>
  );
}

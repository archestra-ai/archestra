"use client";

import { ARCHESTRA_MCP_CATALOG_ID } from "@archestra/shared";
import type { LucideIcon } from "lucide-react";
import { Server } from "lucide-react";
import Image from "next/image";
import { useAppIconLogo } from "@/lib/hooks/use-app-name";
import { cn } from "@/lib/utils";

interface McpCatalogIconProps {
  icon?: string | null;
  catalogId?: string;
  size?: number;
  className?: string;
  /**
   * Glyph shown when no icon is set. Defaults to the server glyph; an Apps
   * surface passes `AppWindow` so an app without an icon keeps reading as an
   * app rather than as a server.
   */
  fallback?: LucideIcon;
}

export function McpCatalogIcon({
  icon,
  catalogId,
  size = 20,
  className,
  fallback: Fallback = Server,
}: McpCatalogIconProps) {
  const appIconLogo = useAppIconLogo();

  // All variants are decorative: the icon always sits next to the server's
  // visible name, so it is hidden from assistive technologies.
  if (!icon && catalogId === ARCHESTRA_MCP_CATALOG_ID) {
    return (
      <Image
        src={appIconLogo}
        alt=""
        width={size}
        height={size}
        className={cn("shrink-0 rounded-sm object-contain", className)}
        style={{ width: size, height: size }}
      />
    );
  }

  if (!icon) {
    return (
      <Fallback
        className={cn("shrink-0 text-muted-foreground", className)}
        style={{ width: size, height: size }}
      />
    );
  }

  if (icon.startsWith("data:")) {
    return (
      <Image
        src={icon}
        alt=""
        width={size}
        height={size}
        className={cn("shrink-0 rounded-sm object-contain", className)}
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <span
      aria-hidden
      className={cn("shrink-0 leading-none", className)}
      style={{ fontSize: size }}
    >
      {icon}
    </span>
  );
}

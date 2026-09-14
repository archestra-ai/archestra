"use client";

import type { AgentCatalogId } from "@archestra/shared";
import { Bot } from "lucide-react";
import Image from "next/image";
import { ProviderIcon } from "@/components/provider-icon";
import { cn } from "@/lib/utils";

/**
 * How each maintained template is named, wherever a template is named: the
 * catalog card that creates an agent from it and the runtime pill on an agent
 * that came from it. The platform's own loop is absent because its name is
 * the deployment's (`<app name> Agent`), so the catalog composes it.
 */
export const AGENT_CATALOG_TEMPLATE_NAMES: Record<
  Exclude<AgentCatalogId, "archestra">,
  string
> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  hermes: "Hermes",
  openclaw: "OpenClaw",
};

/**
 * A template's mark, drawn the same way at every size: the catalog card at
 * 22px and the runtime pill at 12px. Each mark carries the treatment its
 * artwork needs (an inverted monochrome, a rounded raster) so a caller never
 * has to know which template it is drawing.
 */
export function CatalogAgentIcon({
  id,
  appIconLogo = null,
  size = 22,
  className,
}: {
  id: AgentCatalogId;
  /** The deployment's icon, for the platform's own template. */
  appIconLogo?: string | null;
  size?: number;
  className?: string;
}) {
  const box = { width: size, height: size };
  switch (id) {
    case "archestra":
      return appIconLogo ? (
        <Image
          src={appIconLogo}
          alt=""
          width={size}
          height={size}
          style={box}
          className={cn("shrink-0 rounded-sm object-contain", className)}
        />
      ) : (
        <Bot className={cn("shrink-0", className)} style={box} />
      );
    case "claude-code":
      return <ProviderIcon provider="anthropic" size={size} />;
    case "codex":
      return <ProviderIcon provider="openai" size={size} />;
    case "opencode":
      return (
        <Image
          src="/agent-logos/opencode.svg"
          alt=""
          width={size}
          height={size}
          style={{ height: size }}
          className={cn(
            "w-auto shrink-0 object-contain dark:invert",
            className,
          )}
        />
      );
    case "hermes":
      return (
        <Image
          src="/agent-logos/hermes.png"
          alt=""
          width={size}
          height={size}
          style={box}
          className={cn("shrink-0 rounded-sm object-contain", className)}
        />
      );
    case "openclaw":
      return (
        <Image
          src="/agent-logos/openclaw.svg"
          alt=""
          width={size}
          height={size}
          style={box}
          className={cn("shrink-0 object-contain", className)}
        />
      );
    default:
      return <Bot className={cn("shrink-0", className)} style={box} />;
  }
}

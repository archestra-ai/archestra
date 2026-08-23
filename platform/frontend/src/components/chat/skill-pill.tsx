"use client";

import Link from "next/link";
import type React from "react";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useExternalMcpSkills } from "@/lib/skills/skill.query";
import { cn } from "@/lib/utils";

export function getSkillPillDisplay(skillName: string | null): {
  name: string | null;
  source: string | null;
  externalMcp: boolean;
  scope: "personal" | "team" | "org" | null;
  serverIdPrefix: string | null;
} {
  if (!skillName)
    return {
      name: null,
      source: null,
      externalMcp: false,
      scope: null,
      serverIdPrefix: null,
    };
  const external = /^(.+) \[(personal|team|org):([^ ]+)\] \/ (.+)$/.exec(
    skillName,
  );
  if (!external)
    return {
      name: skillName,
      source: null,
      externalMcp: false,
      scope: null,
      serverIdPrefix: null,
    };
  return {
    name: external[4]?.trim() || skillName,
    source: external[1]?.trim() || null,
    externalMcp: true,
    scope: external[2] as "personal" | "team" | "org",
    serverIdPrefix: external[3] ?? null,
  };
}

/**
 * Compact Skill attribution shared by assistant load_skill calls and
 * slash-command user messages. Technical external-install qualifiers stay out
 * of the primary surface; source provenance remains available on hover.
 */
export function SkillPill({
  skillName,
  className,
  children,
  href,
  showNativeTitle = true,
  title,
  ...rest
}: SkillPillProps) {
  const { data: canReadSkills } = useHasPermissions({ skill: ["read"] });
  const display = getSkillPillDisplay(skillName);
  const { data: externalSkills = [] } = useExternalMcpSkills({
    enabled:
      canReadSkills === true && display.externalMcp && href === undefined,
  });
  const externalSkill = externalSkills.find(
    (skill) =>
      skill.name === display.name &&
      skill.serverName === display.source &&
      skill.scope === display.scope &&
      (display.serverIdPrefix === null ||
        skill.mcpServerId.startsWith(display.serverIdPrefix)),
  );
  const skillsHref =
    display.name && canReadSkills === true
      ? (href ??
        (externalSkill
          ? `/skills/external/${externalSkill.id}?mcpServerId=${externalSkill.mcpServerId}`
          : !display.externalMcp
            ? `/skills?search=${encodeURIComponent(display.name)}&openEdit=${encodeURIComponent(display.name)}`
            : null))
      : null;
  const sourceTitle =
    display.name && display.source
      ? `${display.name} from ${display.source}`
      : undefined;

  return (
    <div
      {...rest}
      title={showNativeTitle ? (title ?? sourceTitle) : title}
      className={cn(
        "relative inline-flex h-7 min-w-0 max-w-[min(24rem,calc(100vw-5rem))] items-center rounded-md bg-muted/60 px-2.5 transition-colors",
        skillsHref && "hover:bg-muted",
        className,
      )}
    >
      {display.name ? (
        skillsHref ? (
          <Link
            href={skillsHref}
            className="min-w-0 truncate text-xs font-medium text-foreground transition-colors hover:text-primary"
          >
            {display.name}
          </Link>
        ) : (
          <span className="min-w-0 truncate text-xs font-medium text-foreground/80">
            {display.name}
            {display.source && (
              <span className="sr-only"> from {display.source}</span>
            )}
          </span>
        )
      ) : (
        <span className="text-xs text-muted-foreground">Loading skill</span>
      )}
      {children}
    </div>
  );
}

interface SkillPillProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Raw load_skill name. External MCP qualifiers are reduced for display. */
  skillName: string | null;
  /** Optional adornment (e.g. status dot) absolutely-positioned in the corner. */
  children?: React.ReactNode;
  /** Disable when a custom tooltip already provides the source description. */
  showNativeTitle?: boolean;
  /** Exact Skill route when identity is already available in message metadata. */
  href?: string;
}

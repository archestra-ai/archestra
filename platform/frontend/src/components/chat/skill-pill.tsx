"use client";

import Link from "next/link";
import type React from "react";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { cn } from "@/lib/utils";

interface SkillPillProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Skill name to display. When null, the pill collapses to a 32×32 placeholder. */
  skillName: string | null;
  /** Optional adornment (e.g. status dot) absolutely-positioned in the corner. */
  children?: React.ReactNode;
}

/**
 * Shared "Skill: <name>" pill used both in the assistant's tool-call row
 * (`archestra__load_skill`) and in the user-message attribution badge for
 * skills invoked via slash command. When the user has `skill:read`, the name
 * deep-links to /skills with the editor pre-opened for that skill.
 */
export function SkillPill({
  skillName,
  className,
  children,
  ...rest
}: SkillPillProps) {
  const { data: canReadSkills } = useHasPermissions({ skill: ["read"] });
  const skillsHref =
    skillName && canReadSkills === true
      ? `/skills?search=${encodeURIComponent(skillName)}&openEdit=${encodeURIComponent(skillName)}`
      : null;

  return (
    <div
      {...rest}
      className={cn(
        "relative inline-flex items-center h-8 rounded-full border bg-background",
        skillName ? "px-3" : "size-8 justify-center",
        className,
      )}
    >
      {skillName ? (
        <span className="text-xs text-muted-foreground mr-1">Skill:</span>
      ) : (
        <span className="text-xs text-muted-foreground">Skill</span>
      )}
      {skillName ? (
        skillsHref ? (
          <Link
            href={skillsHref}
            className="text-xs font-medium text-foreground hover:underline underline-offset-2 whitespace-nowrap"
          >
            {skillName}
          </Link>
        ) : (
          <span className="text-xs font-medium text-muted-foreground whitespace-nowrap">
            {skillName}
          </span>
        )
      ) : null}
      {children}
    </div>
  );
}

"use client";

import { BookOpen, PanelsTopLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useFeature } from "@/lib/config/config.query";
import { cn } from "@/lib/utils";

export function McpCapabilityBadges({
  providesUi,
  providesSkills,
  skillCount = 0,
  className,
}: {
  providesUi?: boolean;
  providesSkills?: boolean;
  skillCount?: number;
  className?: string;
}) {
  const skillsEnabled = useFeature("mcpGatewaySkillsEnabled") === true;
  const showSkills = skillsEnabled && providesSkills && skillCount > 0;
  if (!providesUi && !showSkills) return null;

  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1", className)}>
      {providesUi ? (
        <Badge
          variant="outline"
          className="gap-1 px-1.5 py-0 font-normal text-muted-foreground"
          title="Provides interactive MCP Apps"
        >
          <PanelsTopLeft className="size-3" />
          <span>Apps</span>
        </Badge>
      ) : null}
      {showSkills ? (
        <Badge
          variant="outline"
          className="gap-1 px-1.5 py-0 font-normal text-muted-foreground"
          title={`Provides ${skillCount} ${skillCount === 1 ? "skill" : "skills"}`}
        >
          <BookOpen className="size-3" />
          <span>Skills</span>
        </Badge>
      ) : null}
    </span>
  );
}

"use client";

import { Folder } from "lucide-react";
import { AgentIcon } from "@/components/agent-icon";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function ProjectBadgeButton({
  projectId,
  projectName,
  projectIcon,
  onNavigate,
  className,
  compact = false,
}: {
  projectId: string;
  projectName: string;
  projectIcon?: string | null;
  onNavigate: (projectId: string) => void;
  className?: string;
  compact?: boolean;
}) {
  const button = (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label={`Open project ${projectName}`}
      className={cn(
        "h-5 shrink-0 gap-1 rounded-full bg-muted py-0 text-[10px] font-normal text-muted-foreground hover:bg-accent hover:text-foreground",
        compact ? "size-5 px-0" : "max-w-28 px-2",
        className,
      )}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onNavigate(projectId);
      }}
    >
      {projectIcon ? (
        <AgentIcon icon={projectIcon} fallbackType="project" size={10} />
      ) : (
        <Folder className="size-2 shrink-0" />
      )}
      {!compact && <span className="truncate">{projectName}</span>}
    </Button>
  );

  if (!compact) return button;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right">{projectName}</TooltipContent>
    </Tooltip>
  );
}

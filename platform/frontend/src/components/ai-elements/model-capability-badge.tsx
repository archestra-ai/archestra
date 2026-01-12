"use client";

import type { ModelCapability } from "@shared";
import { CAPABILITY_INFO } from "@shared";
import {
  Brain,
  Code2,
  Database,
  Expand,
  Eye,
  FileJson,
  GitBranch,
  ImagePlus,
  Layers,
  MessageSquare,
  Mic,
  Sparkles,
  Terminal,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const ICON_COMPONENTS: Record<string, typeof Sparkles> = {
  Brain,
  Eye,
  Layers,
  Mic,
  Code2,
  MessageSquare,
  Zap,
  FileJson,
  GitBranch,
  Terminal,
  Expand,
  ImagePlus,
  Database,
  Sparkles,
};

const CAPABILITY_COLORS: Record<string, string> = {
  reasoning:
    "bg-purple-100 text-purple-700 border-purple-200 dark:bg-purple-900/30 dark:text-purple-400 dark:border-purple-800",
  vision:
    "bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800",
  multimodal:
    "bg-indigo-100 text-indigo-700 border-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-400 dark:border-indigo-800",
  audio:
    "bg-pink-100 text-pink-700 border-pink-200 dark:bg-pink-900/30 dark:text-pink-400 dark:border-pink-800",
  code: "bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800/50 dark:text-slate-400 dark:border-slate-700",
  chat: "bg-green-100 text-green-700 border-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800",
  "function-calling":
    "bg-yellow-100 text-yellow-700 border-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-400 dark:border-yellow-800",
  "json-mode":
    "bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-900/30 dark:text-orange-400 dark:border-orange-800",
  streaming:
    "bg-cyan-100 text-cyan-700 border-cyan-200 dark:bg-cyan-900/30 dark:text-cyan-400 dark:border-cyan-800",
  "parallel-tools":
    "bg-teal-100 text-teal-700 border-teal-200 dark:bg-teal-900/30 dark:text-teal-400 dark:border-teal-800",
  "system-prompt":
    "bg-gray-100 text-gray-700 border-gray-200 dark:bg-gray-800/50 dark:text-gray-400 dark:border-gray-700",
  "context-window":
    "bg-violet-100 text-violet-700 border-violet-200 dark:bg-violet-900/30 dark:text-violet-400 dark:border-violet-800",
  "image-gen":
    "bg-fuchsia-100 text-fuchsia-700 border-fuchsia-200 dark:bg-fuchsia-900/30 dark:text-fuchsia-400 dark:border-fuchsia-800",
  embedding:
    "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800",
  "fine-tuned":
    "bg-rose-100 text-rose-700 border-rose-200 dark:bg-rose-900/30 dark:text-rose-400 dark:border-rose-800",
};

interface ModelCapabilityBadgeProps {
  capability: ModelCapability;
  className?: string;
  size?: "sm" | "md";
}

export function ModelCapabilityBadge({
  capability,
  className,
  size = "md",
}: ModelCapabilityBadgeProps) {
  const info = CAPABILITY_INFO[capability];
  if (!info) return null;

  const IconComponent = ICON_COMPONENTS[info.icon] || Sparkles;
  const colors =
    CAPABILITY_COLORS[capability] || "bg-muted text-muted-foreground";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          className={cn(
            "inline-flex items-center gap-1.5 border font-medium transition-all hover:scale-[1.02]",
            colors,
            size === "sm" ? "px-1.5 py-0.5 text-[10px]" : "px-2.5 py-1 text-xs",
            className,
          )}
        >
          <IconComponent
            className={cn("shrink-0", size === "sm" ? "size-3" : "size-3.5")}
          />
          <span className="truncate">{info.label}</span>
        </Badge>
      </TooltipTrigger>
      <TooltipContent>
        <div className="space-y-1">
          <p className="font-semibold">{info.label}</p>
          <p className="text-muted-foreground text-xs max-w-[200px]">
            {info.description}
          </p>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

interface ModelCapabilitiesListProps {
  capabilities: ModelCapability[];
  className?: string;
  maxDisplay?: number;
  size?: "sm" | "md";
}

export function ModelCapabilitiesList({
  capabilities,
  className,
  maxDisplay = 3,
  size = "md",
}: ModelCapabilitiesListProps) {
  if (!capabilities?.length) return null;

  const sortedCapabilities = capabilities
    .map((cap) => ({ cap, priority: CAPABILITY_INFO[cap]?.priority || 999 }))
    .sort((a, b) => a.priority - b.priority)
    .map(({ cap }) => cap);

  const displayCapabilities = sortedCapabilities.slice(0, maxDisplay);
  const hiddenCount = sortedCapabilities.length - maxDisplay;

  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {displayCapabilities.map((capability) => (
        <ModelCapabilityBadge
          key={capability}
          capability={capability}
          size={size}
        />
      ))}
      {hiddenCount > 0 && (
        <Badge
          variant="secondary"
          className={cn(
            "font-medium",
            size === "sm" ? "px-1.5 py-0.5 text-[10px]" : "px-2.5 py-1 text-xs",
          )}
        >
          +{hiddenCount}
        </Badge>
      )}
    </div>
  );
}

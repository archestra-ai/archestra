"use client";

import { Tag } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface Label {
  key: string;
  value: string;
}

interface LabelTagsProps {
  labels: Label[];
}

export function LabelTags({ labels }: LabelTagsProps) {
  if (!labels || labels.length === 0) return null;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="inline-flex shrink-0"
            aria-label={`View ${labels.length} ${labels.length === 1 ? "label" : "labels"}`}
            onClick={(event) => event.stopPropagation()}
          >
            <Tag className="h-4 w-4 text-muted-foreground" />
          </button>
        </TooltipTrigger>
        <TooltipContent>
          <div className="flex flex-wrap gap-1 max-w-xs">
            {labels.map((label) => (
              <Badge key={label.key} variant="secondary" className="text-xs">
                <span className="font-semibold">{label.key}:</span>
                <span className="ml-1">{label.value}</span>
              </Badge>
            ))}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

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
          <div className="inline-flex">
            <Tag className="h-4 w-4 text-muted-foreground" />
          </div>
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

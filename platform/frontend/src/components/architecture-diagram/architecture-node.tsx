"use client";

import { Handle, type Node, type NodeProps, Position } from "@xyflow/react";
import { memo } from "react";
import { cn } from "@/lib/utils";

// Map highlight colors to chart CSS variables
// chart-1: blue (LLM Gateway), chart-2: green (MCP Gateway), chart-3: amber (A2A Gateway)
export type HighlightColor = "chart-1" | "chart-2" | "chart-3";

export type ArchitectureNodeData = {
  label: string;
  highlighted?: boolean;
  highlightColor?: HighlightColor;
  isGroup?: boolean;
  groupLabel?: string;
};

export type ArchitectureNodeType = Node<ArchitectureNodeData, "architecture">;

export const ArchitectureNode = memo(
  ({ data }: NodeProps<ArchitectureNodeType>) => {
    const { label, highlighted, highlightColor, isGroup, groupLabel } = data;

    if (isGroup) {
      return (
        <div className="rounded-lg border border-border/50 bg-muted/20 px-3 py-2 min-w-[120px]">
          {groupLabel && (
            <div className="text-[10px] text-muted-foreground mb-1 font-medium">
              {groupLabel}
            </div>
          )}
          <div className="text-xs font-medium text-foreground">{label}</div>
        </div>
      );
    }

    const highlightStyle =
      highlighted && highlightColor
        ? {
            backgroundColor: `var(--${highlightColor})`,
            borderColor: `var(--${highlightColor})`,
            color: "white",
          }
        : undefined;

    return (
      <div
        className={cn(
          "rounded-md border px-3 py-1.5 text-xs font-medium transition-colors min-w-[90px] text-center whitespace-pre-line",
          !highlighted && "bg-card border-border text-card-foreground",
        )}
        style={highlightStyle}
      >
        <Handle
          type="target"
          position={Position.Left}
          className="!bg-transparent !border-0 !w-1 !h-1"
        />
        {label}
        <Handle
          type="source"
          position={Position.Right}
          className="!bg-transparent !border-0 !w-1 !h-1"
        />
      </div>
    );
  },
);

ArchitectureNode.displayName = "ArchitectureNode";

"use client";

import type { Node, NodeProps } from "@xyflow/react";
import Image from "next/image";
import { memo } from "react";
import { cn } from "@/lib/utils";

export type ArchitectureGroupNodeData = {
  label: string;
  width: number;
  height: number;
  highlighted?: boolean;
  highlightColor?: "blue" | "green" | "orange";
  logo?: string;
};

export type ArchitectureGroupNodeType = Node<
  ArchitectureGroupNodeData,
  "architectureGroup"
>;

export const ArchitectureGroupNode = memo(
  ({ data }: NodeProps<ArchitectureGroupNodeType>) => {
    const { label, width, height, highlighted, highlightColor, logo } = data;

    return (
      <div
        className={cn(
          "rounded-lg border bg-muted/30",
          highlighted && highlightColor === "blue"
            ? "border-blue-500/50 bg-blue-500/10"
            : highlighted && highlightColor === "green"
              ? "border-emerald-500/50 bg-emerald-500/10"
              : highlighted && highlightColor === "orange"
                ? "border-orange-500/50 bg-orange-500/10"
                : "border-border/50",
        )}
        style={{ width, height }}
      >
        <div className="px-3 py-1.5 text-[10px] text-muted-foreground font-medium flex items-center gap-1.5">
          {logo && (
            <Image
              src={logo}
              alt=""
              width={14}
              height={14}
              className="shrink-0"
            />
          )}
          {label}
        </div>
      </div>
    );
  },
);

ArchitectureGroupNode.displayName = "ArchitectureGroupNode";

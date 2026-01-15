"use client";

import type { Node, NodeProps } from "@xyflow/react";
import Image from "next/image";
import { memo } from "react";
import type { HighlightColor } from "./architecture-node";

export type ArchitectureGroupNodeData = {
  label: string;
  width: number;
  height: number;
  highlighted?: boolean;
  highlightColor?: HighlightColor;
  logo?: string;
};

export type ArchitectureGroupNodeType = Node<
  ArchitectureGroupNodeData,
  "architectureGroup"
>;

export const ArchitectureGroupNode = memo(
  ({ data }: NodeProps<ArchitectureGroupNodeType>) => {
    const { label, width, height, highlighted, highlightColor, logo } = data;

    const highlightStyle =
      highlighted && highlightColor
        ? {
            borderColor: `color-mix(in oklch, var(--${highlightColor}) 50%, transparent)`,
            backgroundColor: `color-mix(in oklch, var(--${highlightColor}) 10%, transparent)`,
          }
        : undefined;

    return (
      <div
        className={
          highlighted
            ? "rounded-lg border bg-muted/30"
            : "rounded-lg border bg-muted/30 border-border/50"
        }
        style={{ width, height, ...highlightStyle }}
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

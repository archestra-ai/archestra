"use client";

import type { DynamicToolUIPart, ToolUIPart } from "ai";
import { cn } from "@/lib/utils";

const GRYFFINDOR = "gryffindor";

type ToolPartLike = Pick<
  ToolUIPart | DynamicToolUIPart,
  "input" | "output"
> | null;

export function hasGryffindorSorting(
  part: ToolPartLike,
  toolResultPart?: ToolPartLike,
): boolean {
  return (
    readHouse(toolResultPart?.output) === GRYFFINDOR ||
    readHouse(part?.output) === GRYFFINDOR ||
    readHouse(part?.input) === GRYFFINDOR
  );
}

export function GoldenSnitchLoader({ className }: { className?: string }) {
  return (
    <span
      aria-label="Golden Snitch loader"
      className={cn(
        "relative inline-flex size-4 items-center justify-center",
        className,
      )}
      data-testid="golden-snitch-loader"
      role="img"
    >
      <span className="-translate-x-1.5 absolute h-1.5 w-2.5 animate-pulse rounded-full bg-amber-200/80" />
      <span className="absolute h-2.5 w-2.5 animate-bounce rounded-full bg-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.85)]" />
      <span className="absolute h-1 w-1 rounded-full bg-amber-50" />
      <span className="absolute h-1.5 w-2.5 translate-x-1.5 animate-pulse rounded-full bg-amber-200/80" />
    </span>
  );
}

function readHouse(value: unknown, depth = 0): string | undefined {
  if (depth > 3 || value == null) return undefined;

  if (typeof value === "string") {
    try {
      return readHouse(JSON.parse(value), depth + 1);
    } catch {
      return undefined;
    }
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const house = readHouse(item, depth + 1);
      if (house) return house;
    }
    return undefined;
  }

  if (typeof value !== "object") return undefined;

  const record = value as Record<string, unknown>;
  const house = record.house;
  if (typeof house === "string") {
    return house.toLowerCase();
  }

  return (
    readHouse(record.structuredContent, depth + 1) ??
    readHouse(record.content, depth + 1) ??
    readHouse(record.rawContent, depth + 1)
  );
}

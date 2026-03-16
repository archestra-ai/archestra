"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function TableFilters({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-4 flex flex-wrap items-center gap-3", className)}>
      {children}
    </div>
  );
}

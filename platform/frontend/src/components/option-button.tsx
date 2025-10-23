"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export default function OptionButton({
  active,
  onClick,
  children,
  className = "",
}: {
  active?: boolean;
  onClick?: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "min-w-[120px] rounded-md border px-3 py-2 text-sm text-left transition",
        active
          ? "border-blue-500 bg-slate-800"
          : "border-slate-700 bg-transparent",
        className,
      )}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}

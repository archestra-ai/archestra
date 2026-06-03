import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export type GoldenSnitchLoaderProps = HTMLAttributes<HTMLDivElement> & {
  size?: number;
};

export function GoldenSnitchLoader({
  className,
  size = 18,
  ...props
}: GoldenSnitchLoaderProps) {
  return (
    <div
      className={cn(
        "relative inline-flex items-center justify-center text-amber-500",
        className,
      )}
      style={{ width: size, height: size }}
      aria-label="Golden Snitch loader"
      {...props}
    >
      <span className="absolute h-1.5 w-5 animate-pulse rounded-full bg-current opacity-30" />
      <svg
        aria-hidden="true"
        className="relative animate-spin"
        height={size}
        viewBox="0 0 24 24"
        width={size}
      >
        <path
          d="M9 12c-2.6-2.4-5.1-3.3-7.5-2.7 2.1 1.4 3.8 3 5.1 4.9"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="1.7"
        />
        <path
          d="M15 12c2.6-2.4 5.1-3.3 7.5-2.7-2.1 1.4-3.8 3-5.1 4.9"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="1.7"
        />
        <circle cx="12" cy="12" fill="currentColor" r="3.2" />
        <circle cx="11" cy="10.8" fill="white" opacity="0.55" r="0.8" />
      </svg>
    </div>
  );
}

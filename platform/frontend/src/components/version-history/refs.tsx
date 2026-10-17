import { cn } from "@/lib/utils/tailwind";
import { HASH_TEXT } from "./tones";

/** How many hash characters identify a version among its neighbours. */
export const SHORT_HASH_LENGTH = 7;

/**
 * `HEAD -> current`: the ref chip that marks the version the entity is on
 * now, the way `git log --decorate` marks the checked-out commit.
 */
export function HeadRef({ size = "sm" }: { size?: "sm" | "md" }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-[3px] border border-primary/40 bg-primary/[0.08] font-mono leading-none",
        size === "sm" ? "h-[17px] px-1 text-[10.5px]" : "h-6 px-2 text-xs",
      )}
    >
      <span className="font-semibold text-primary">HEAD</span>
      <span aria-hidden className="text-primary/55">
        -&gt;
      </span>
      <span className="text-primary">current</span>
    </span>
  );
}

/** A `vN` tag chip; `strong` for the selected row. */
export function VersionRef({
  version,
  strong = false,
}: {
  version: number;
  strong?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-[17px] shrink-0 items-center rounded-[3px] border px-1 font-mono text-[10.5px] leading-none font-semibold tabular-nums",
        strong
          ? "border-foreground/30 text-foreground"
          : "border-border text-foreground/75",
      )}
    >
      v{version}
    </span>
  );
}

/** A content hash cut to its short form, in the log's hash colour. */
export function ShortHash({
  hash,
  className,
}: {
  hash: string;
  className?: string;
}) {
  return (
    <span
      className={cn("shrink-0 font-mono tabular-nums", HASH_TEXT, className)}
    >
      {hash.slice(0, SHORT_HASH_LENGTH)}
    </span>
  );
}

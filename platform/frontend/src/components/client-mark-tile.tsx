import type { ClientMark } from "@archestra/shared";
import { cn } from "@/lib/utils/tailwind";

/**
 * A client's mark on its rounded tile. The Connect page tile, agents made
 * from the agent catalog, and the client icon in the LLM logs and on the
 * Plugin pages draw a mark through this, so the same client looks alike at
 * every size and in both themes.
 */
export function ClientMarkTile({
  mark,
  label,
  size,
  className,
}: {
  mark: ClientMark;
  label: string;
  size: number;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center border",
        className,
      )}
      style={{
        width: size,
        height: size,
        borderRadius: markTileRadius(size),
        background: mark.background,
      }}
    >
      <svg
        viewBox={mark.viewBox}
        width={size * 0.6}
        height={size * 0.6}
        role="img"
        aria-label={`${label} logo`}
      >
        {mark.accent && <path d={mark.accent.path} fill={mark.accent.color} />}
        <path d={mark.path} fill={mark.color} fillRule={mark.fillRule} />
      </svg>
    </div>
  );
}

/** Corner radius of a client tile `size` px wide. */
export function markTileRadius(size: number): number {
  return Math.round(size / 4.25);
}

import type { ClientMark } from "@archestra/shared";

/**
 * A client's mark on its rounded tile. The Connect page tile and the client
 * icon in the LLM logs and on the Plugin pages draw a mark through this, so
 * the same client looks alike at every size and in both themes.
 */
export function ClientMarkTile({
  mark,
  label,
  size,
}: {
  mark: ClientMark;
  label: string;
  size: number;
}) {
  return (
    <div
      className="flex shrink-0 items-center justify-center border"
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

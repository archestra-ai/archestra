import { Database, Trash2 } from "lucide-react";
import type { CSSProperties } from "react";
import { cn } from "@/lib/utils/tailwind";
import { identiconHue, initialsOf } from "./logs-table-format";

// People are round and agents are square, so the two never read as the same
// kind of thing. Both take a deterministic hue from their seed, drawn at a fixed
// OKLCH lightness and chroma so every hue carries the same visual weight; dark
// mode flips to a deep fill with light ink.

/** A person's initials on their hue. */
export function PersonAvatar({
  name,
  size,
  ring = true,
}: {
  name: string;
  size: number;
  /** Separates overlapping avatars from what they sit on. */
  ring?: boolean;
}) {
  return (
    <span
      role="img"
      aria-label={name}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full font-semibold tracking-tight",
        HUE_TONE,
        ring && "ring-2 ring-background",
      )}
      style={hueStyle(name, {
        width: size,
        height: size,
        fontSize: size * 0.45,
      })}
    >
      {initialsOf(name)}
    </span>
  );
}

/**
 * An agent's square tile: initials on the hue of its id, a database glyph for
 * the knowledge base, a dashed trash can once the agent is gone. `md` fronts
 * a table cell; `sm` sits inline in a line of text.
 */
export function AgentIdenticon({
  seed,
  name,
  variant,
  size = "md",
}: {
  seed: string;
  name: string;
  variant: "agent" | "knowledge" | "deleted";
  size?: "sm" | "md";
}) {
  const dims = IDENTICON_SIZES[size];
  if (variant === "deleted") {
    return (
      <span
        role="img"
        aria-label={name}
        className={cn(
          "flex shrink-0 items-center justify-center border border-dashed border-muted-foreground/50 text-muted-foreground",
          dims.tile,
        )}
      >
        <Trash2 className={dims.glyph} aria-hidden="true" />
      </span>
    );
  }
  return (
    <span
      role="img"
      aria-label={name}
      className={cn(
        "flex shrink-0 items-center justify-center font-semibold tracking-tight ring-1 ring-black/[0.04] ring-inset dark:ring-white/[0.08]",
        dims.tile,
        HUE_TONE,
      )}
      style={hueStyle(seed)}
    >
      {variant === "knowledge" ? (
        <Database
          className={dims.glyph}
          strokeWidth={2.25}
          aria-hidden="true"
        />
      ) : (
        initialsOf(withoutGenericWords(name))
      )}
    </span>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

const IDENTICON_SIZES = {
  sm: { tile: "size-[18px] rounded-[5px] text-[8px]", glyph: "size-2.5" },
  md: { tile: "size-8 rounded-lg text-[11px]", glyph: "size-3.5" },
} as const;

const HUE_TONE =
  "bg-[oklch(0.93_0.045_var(--hue))] text-[oklch(0.44_0.12_var(--hue))] dark:bg-[oklch(0.34_0.07_var(--hue))] dark:text-[oklch(0.9_0.07_var(--hue))]";

function hueStyle(seed: string, extra: CSSProperties = {}): CSSProperties {
  return { "--hue": identiconHue(seed), ...extra } as CSSProperties;
}

/** "Support LLM Proxy" → "Support", so its initial is not a generic "L". */
function withoutGenericWords(name: string): string {
  return name.replace(/\b(llm|proxy|gateway)\b/gi, "").trim() || name;
}

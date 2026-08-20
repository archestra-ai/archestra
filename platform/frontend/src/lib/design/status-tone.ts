import type { McpServerIssueSeverity } from "@/lib/mcp/mcp-server-issues";

/**
 * The three tones a status pill can carry, and the only place their colours
 * are written down.
 *
 * These used to be `text-red-700 dark:text-red-400` and friends, spelled out
 * per badge. Raw palette colours cannot work here: the theme is a persisted
 * field with 24 values, each with a light and a dark palette, so a red picked
 * against one theme's card is picked against 47 other surfaces by accident.
 * Every colour below therefore resolves through the theme's own tokens
 * (`--tone-*` in `app/globals.css`), which are in turn derived from
 * `--destructive`, `--muted-foreground` and `--foreground`.
 *
 * All three tones share one shape: a translucent tint of the tone's hue, a
 * border of the same hue, and text mixed from that hue and the theme's
 * foreground. The text therefore sits on a composite of the fill and whatever
 * is behind it. The three surfaces these pills actually appear on are `--card`,
 * the header band's `bg-card/30` over `--background`, and `--muted`;
 * `tests-integration/status-tone-contrast.spec.ts` renders all 3 tones x 3
 * surfaces x 48 palettes in a real browser and asserts each clears WCAG AA
 * 4.5:1, and that no fill comes out indistinguishable from the surface under
 * it. Badge text is 12px, so the large-text exemption does not apply and 4.5:1
 * is the real floor.
 *
 * Changing a class string here changes what that spec measures. It applies
 * these strings to a real element rather than reading a duplicated colour
 * spec, so the two cannot drift.
 */

/**
 * Down: the thing is not working and somebody has to act.
 * Attention: it works, but it is degraded or waiting on a decision.
 * Progress: the system is working on it and nobody needs to act.
 *
 * Keyed by `McpServerIssueSeverity` so an issue's severity indexes the map
 * directly. The `satisfies` is the link: renaming a severity on the MCP side
 * breaks this build rather than silently returning `undefined` and painting a
 * badge with no tone at all.
 */
export const STATUS_TONE = {
  down: "border border-tone-down/35 bg-tone-down/12 text-tone-down-foreground",
  attention:
    "border border-tone-attention/35 bg-tone-attention/12 text-tone-attention-foreground",
  progress:
    "border border-tone-progress/35 bg-tone-progress/12 text-tone-progress-foreground",
} satisfies Record<McpServerIssueSeverity, string>;

export type StatusTone = keyof typeof STATUS_TONE;

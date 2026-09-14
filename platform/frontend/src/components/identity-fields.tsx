"use client";

import type { AgentIconPickerFallback } from "@/components/agent-icon-picker";
import { AgentIconPicker } from "@/components/agent-icon-picker";

/**
 * The block every entity form opens with: an icon picker beside the labelled
 * field that names the thing — agents, projects, apps and MCP servers all
 * start this way.
 *
 * It exists so they cannot drift apart. Choosing an emoji looked different in
 * each place (beside the name field here, above it there, labelled in one form
 * and unlabelled in the next), which read as four unrelated controls rather
 * than one. The layout lives here; each form still owns its own fields, because
 * they are wired to four different form libraries and abstracting that would
 * cost more than the consistency is worth.
 *
 * The layout is a two-column grid: the `label` sits above the name field in
 * the second column, and the picker shares the second row with the field, so
 * the two line up whatever the label's height and whatever the caller stacks
 * above or below the input. Pass a real `<Label>` (plus any description that
 * belongs under it) as `label`, and the input with its messages as `children`.
 */
export function IdentityFields({
  icon,
  onIconChange,
  fallbackType,
  showLogos,
  disabled,
  label,
  children,
}: {
  icon: string | null;
  onIconChange: (icon: string | null) => void;
  /** Glyph shown before an icon is chosen (defaults to the agent bot). */
  fallbackType?: AgentIconPickerFallback;
  /**
   * Offer the brand-logo tab first. For an MCP server the icon is usually the
   * logo of the service it wraps; everywhere else an emoji is the likelier
   * pick, so the layout stays the same and only the opening tab differs.
   */
  showLogos?: boolean;
  /** Render the icon as orientation rather than an edit control. */
  disabled?: boolean;
  /** The label (and any description) shown above the name field. */
  label: React.ReactNode;
  /** The name field, with any validation message, beside the picker. */
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2">
      <div className="col-start-2 grid gap-2">{label}</div>
      <AgentIconPicker
        value={icon}
        onChange={onIconChange}
        fallbackType={fallbackType}
        showLogos={showLogos}
        disabled={disabled}
        className="col-start-1 row-start-2 size-9 self-start rounded-md"
      />
      <div className="col-start-2 row-start-2 grid gap-2">{children}</div>
    </div>
  );
}

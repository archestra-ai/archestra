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
 * Pass the name field as `children`, with a real `<Label>`.
 */
export function IdentityFields({
  icon,
  onIconChange,
  fallbackType,
  showLogos,
  disabled,
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
  /** The labelled name field that sits beside the picker. */
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <AgentIconPicker
        value={icon}
        onChange={onIconChange}
        fallbackType={fallbackType}
        showLogos={showLogos}
        disabled={disabled}
        className="mt-6 size-9 rounded-md"
      />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

"use client";

import type { AgentIconPickerFallback } from "@/components/agent-icon-picker";
import { AgentIconPicker } from "@/components/agent-icon-picker";

/**
 * The block every entity form opens with: the icon picker on its own row, then
 * the labelled fields that name the thing — agents, projects, apps and MCP
 * servers all start this way.
 *
 * It exists so they cannot drift apart. Choosing an emoji looked different in
 * each place (beside the name field here, above it there, labelled in one form
 * and unlabelled in the next), which read as four unrelated controls rather
 * than one. The layout lives here; each form still owns its own fields, because
 * they are wired to four different form libraries and abstracting that would
 * cost more than the consistency is worth.
 *
 * Pass the name/description fields as `children`, each with a real `<Label>`.
 */
export function IdentityFields({
  icon,
  onIconChange,
  fallbackType,
  showLogos,
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
  /** The labelled fields that sit under the picker. */
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-4">
      <AgentIconPicker
        value={icon}
        onChange={onIconChange}
        fallbackType={fallbackType}
        showLogos={showLogos}
      />
      {children}
    </div>
  );
}

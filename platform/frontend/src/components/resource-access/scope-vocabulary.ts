import type { ResourceVisibilityScope } from "@archestra/shared";
import { Globe, User, Users } from "lucide-react";

/**
 * The one definition of how a visibility scope is spoken, drawn and coloured.
 *
 * Every surface that names a scope reads it from here, so a new table, card or
 * picker cannot invent a fourth vocabulary. The copies this replaced had
 * already drifted in both directions: two private `SCOPE_ICONS` maps drew the
 * organization scope as a building while the shared badges drew a globe, and a
 * table printing the raw enum through `capitalize` said "Org" where every badge
 * said "Organization".
 *
 * Light-mode text uses the 700/800 palette steps: the 600 steps fall below the
 * 4.5:1 contrast minimum (WCAG 1.4.3) on the tinted /10 fills. Dark mode's 400
 * steps already pass.
 */
export const SCOPE_META: Record<
  ResourceVisibilityScope,
  { label: string; icon: typeof User; styles: string }
> = {
  personal: {
    label: "Personal",
    icon: User,
    styles:
      "bg-blue-500/10 text-blue-700 border-blue-500/30 dark:text-blue-400 dark:border-blue-400/30",
  },
  team: {
    label: "Team",
    icon: Users,
    styles:
      "bg-green-500/10 text-green-800 border-green-500/30 dark:text-green-400 dark:border-green-400/30",
  },
  org: {
    label: "Organization",
    icon: Globe,
    styles:
      "bg-amber-500/10 text-amber-800 border-amber-500/30 dark:text-amber-400 dark:border-amber-400/30",
  },
};

/**
 * The human label for a scope, so surfaces that spell the scope out in text
 * cannot drift from what the badges say.
 */
export function scopeLabel(scope: ResourceVisibilityScope): string {
  return SCOPE_META[scope].label;
}

/**
 * Badge classes per scope, for surfaces that render their own pill shell rather
 * than one of the shared badge components.
 */
export const scopeStyles: Record<ResourceVisibilityScope, string> = {
  personal: SCOPE_META.personal.styles,
  team: SCOPE_META.team.styles,
  org: SCOPE_META.org.styles,
};

/**
 * For things the platform provides rather than a person or org owning them —
 * a built-in agent, a system-managed credential. Not a visibility scope, but it
 * sits in the same column as one, so it needs to be deliberately distinct from
 * all three rather than falling back to an uncoloured pill that reads as
 * "nobody filled this in".
 */
export const platformOwnedStyles =
  "bg-purple-500/10 text-purple-700 border-purple-500/30 dark:text-purple-400 dark:border-purple-400/30";

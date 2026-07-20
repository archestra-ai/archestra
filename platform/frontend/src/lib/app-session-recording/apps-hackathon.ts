import { isAppsHackathonOpen } from "@archestra/shared";
import { useFeature } from "@/lib/config/config.query";
import { useOrganization } from "@/lib/organization.query";

/**
 * The Apps Hackathon recorder sits behind three gates, and every surface has
 * to agree on them or the UI contradicts the API: a control that renders when
 * the routes behind it answer 403 is worse than no control at all.
 *
 *   deployment — is the feature here? (never on an activated enterprise
 *                licence; see parseHackathonRecorderEnabled)
 *   date       — is the hackathon still running?
 *   organization — does this org want it? (the admin toggle)
 *
 * The backend enforces the same three on every request; these are the
 * client-side halves, so nothing is offered that would then be refused.
 */

/** Where people register — the link the recorder's tooltip offers. */
export const APPS_HACKATHON_REGISTER_URL =
  "https://archestra.ai/apps-hackathon";

/**
 * The admin toggle's anchor, and the link that reaches it. One constant so the
 * "disable this" link in the chat composer and the settings block it scrolls
 * to cannot drift apart.
 */
export const APPS_HACKATHON_SETTING_ANCHOR = "apps-hackathon-recorder";
export const APPS_HACKATHON_SETTINGS_HREF = `/settings/agents#${APPS_HACKATHON_SETTING_ANCHOR}`;

/**
 * Whether this deployment offers the hackathon at all — the first two gates.
 *
 * This is what decides whether the admin toggle is even worth showing: an
 * organization cannot opt into a feature its deployment does not carry, and
 * once the hackathon is over the whole thing goes away rather than lingering
 * as a switch that no longer does anything.
 */
export function useAppsHackathonOffered(): boolean {
  const deploymentEnabled = useFeature("hackathonRecorderEnabled") ?? false;
  return deploymentEnabled && isAppsHackathonOpen();
}

/**
 * Whether the recorder should actually run for this user — all three gates.
 *
 * Defaults closed while the organization is still loading: showing the control
 * and then taking it away reads as a glitch, where showing it a moment late
 * reads as nothing at all.
 */
export function useAppsHackathonAvailable(): boolean {
  const offered = useAppsHackathonOffered();
  const { data: organization } = useOrganization();
  return offered && (organization?.appsHackathonRecorderEnabled ?? false);
}

import {
  APPS_HACKATHON_DATE_RANGE_LABEL,
  isAppsHackathonOpen,
} from "@archestra/shared";
import { useFeature } from "@/lib/config/config.query";
import { useIsMobile } from "@/lib/hooks/use-mobile";
import { useOrganization } from "@/lib/organization.query";

/**
 * The hackathon's dates as UI copy. Re-exported from the shared contract (where
 * it sits beside the gate epochs it must track) so every hackathon surface
 * pulls its date string, and every other hackathon constant, from this one
 * module.
 */
export { APPS_HACKATHON_DATE_RANGE_LABEL };

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
 * Whether this deployment offers the hackathon at all — the deployment flag
 * and the date window.
 *
 * This is what decides whether the admin toggle is even worth showing: an
 * organization cannot opt into a feature its deployment does not carry, and
 * outside the hackathon window the whole thing goes away rather than lingering
 * as a switch that no longer does anything.
 *
 * The staging override bypasses the date window — the same bypass the backend
 * applies — so Archestra's own staging shows the recorder before the hackathon
 * opens and after it closes.
 */
export function useAppsHackathonOffered(): boolean {
  const deploymentEnabled = useFeature("hackathonRecorderEnabled") ?? false;
  const overrideActive = useFeature("hackathonRecorderOverrideActive") ?? false;
  return deploymentEnabled && (overrideActive || isAppsHackathonOpen());
}

/**
 * Whether the recorder should actually run for this user — the three business
 * gates plus one device gate.
 *
 * Off on a phone-sized screen whatever the deployment and organization allow:
 * the recorder captures a desktop app-building session pixel by pixel and its
 * composer cluster has no small-screen layout, so there is nothing a mobile
 * visitor can usefully do with it. The device gate lives HERE and not in
 * `useAppsHackathonOffered`, so an admin on a phone can still reach the toggle
 * in settings even though the recorder itself stays hidden for them.
 *
 * Defaults closed while the organization is still loading: showing the control
 * and then taking it away reads as a glitch, where showing it a moment late
 * reads as nothing at all.
 */
export function useAppsHackathonAvailable(): boolean {
  const offered = useAppsHackathonOffered();
  const { data: organization } = useOrganization();
  const isMobile = useIsMobile();
  return (
    offered &&
    !isMobile &&
    (organization?.appsHackathonRecorderEnabled ?? false)
  );
}

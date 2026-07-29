import {
  APPS_HACKATHON_OPENS_AT_MS,
  isAppsHackathonOpen,
} from "@archestra/shared";
import config from "@/config";
import { OrganizationModel } from "@/models";
import { ApiError } from "@/types";

/**
 * 403 unless the Apps Hackathon recorder is available to this caller.
 *
 * Gates a request has to clear: the deployment must offer the feature at all
 * (community deployments always do; an activated enterprise licence never
 * does), the hackathon must be inside its date window, and the caller's
 * organization must not have switched it off. Not 400 for any of them — the
 * request is well formed and there is nothing the caller can change about it.
 *
 * The date window has no bypass. The staging override forces the deployment
 * flag on for Archestra's own licensed staging (see
 * parseHackathonRecorderEnabled), but the window binds every deployment
 * equally — the hackathon being over means over, staging included.
 *
 * Shared by every hackathon-recorder surface: the app-recording routes and the
 * gallery-share device-auth relay.
 */
export async function assertAppsHackathonAvailable(
  organizationId: string,
): Promise<void> {
  if (!config.hackathonRecorder.enabled) {
    // Only reachable on an activated enterprise licence without the override —
    // community deployments always pass this gate.
    throw new ApiError(
      403,
      "The Apps Hackathon recorder is not available on this deployment.",
    );
  }
  // Read per request rather than captured at boot: a pod that started before
  // an edge of the window would otherwise keep answering as it did then.
  if (!isAppsHackathonOpen()) {
    throw new ApiError(
      403,
      Date.now() < APPS_HACKATHON_OPENS_AT_MS
        ? "The Apps Hackathon has not started yet, so session recording is not available."
        : "The Apps Hackathon has ended, so session recording is no longer available.",
    );
  }
  const organization = await OrganizationModel.getById(organizationId);
  if (!organization?.appsHackathonRecorderEnabled) {
    throw new ApiError(
      403,
      "The Apps Hackathon recorder is switched off for this organization.",
    );
  }
}

/**
 * 403 unless this deployment offers the offline VIDEO export.
 *
 * A separate opt-in on top of the recorder itself: a render drives a headless
 * browser for as long as the cut runs, so it stays off unless an operator asks
 * for it. Enforced on the render routes and not only in the UI — hiding the
 * download button is a presentation choice, and an endpoint that still answers
 * would let anyone spend that budget by calling it directly.
 */
export function assertAppRecordingVideoDownloadAvailable(): void {
  if (!config.hackathonRecorder.videoDownloadEnabled) {
    throw new ApiError(
      403,
      "Video download is not available on this deployment.",
    );
  }
}

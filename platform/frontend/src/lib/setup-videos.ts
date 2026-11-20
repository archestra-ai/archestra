/**
 * URL of a setup walkthrough video in the Slack and Microsoft Teams dialogs.
 *
 * The videos are not part of the platform image, where they added about 80 MB
 * to every pull. Their files live in archestra-ai/infra under
 * `gcp/cloud-run/cdn/files/platform/`, and cdn.archestra.dev serves them: an
 * HTTPS load balancer with Cloud CDN in front of a Cloud Run function that
 * reads a private bucket (README in that root). To add or replace a video,
 * commit it there; CI uploads it on merge. A deployment without internet
 * access shows the setup steps without the videos.
 */
export function setupVideoUrl(
  path: `${"ms-teams" | "slack"}/${string}.mp4`,
): string {
  return `${SETUP_VIDEOS_BASE_URL}/${path}`;
}

const SETUP_VIDEOS_BASE_URL = "https://cdn.archestra.dev/platform";

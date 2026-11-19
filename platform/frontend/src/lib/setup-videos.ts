/**
 * URL of a setup walkthrough video in the Slack and Microsoft Teams dialogs.
 *
 * The videos are not part of the platform image, where they added about 80 MB
 * to every pull. Their files live in archestra-ai/infra under
 * `gcp/cloud-run/cdn/files/platform/`, and a public Cloud Run function in that
 * root serves them from a private bucket (README there). To add or replace a
 * video, commit it there; CI uploads it on merge. A deployment without
 * internet access shows the setup steps without the videos.
 */
export function setupVideoUrl(
  path: `${"ms-teams" | "slack"}/${string}.mp4`,
): string {
  return `${SETUP_VIDEOS_BASE_URL}/${path}`;
}

const SETUP_VIDEOS_BASE_URL =
  "https://cdn-354887056155.europe-west1.run.app/platform";

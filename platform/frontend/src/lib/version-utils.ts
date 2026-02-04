import semver from "semver";

/**
 * Cleans a version string by stripping common prefixes like "platform-" and "v".
 */
function cleanVersionString(version: string): string {
  return version.replace(/^platform-/, "").replace(/^v/, "");
}

/**
 * Determines whether a newer version is available by comparing the current version
 * against the latest release tag. Uses semver for proper comparison.
 *
 * Returns false if either version is not valid semver (e.g. dev/commit-hash builds).
 */
export function hasNewerVersion(
  currentVersion: string,
  latestTagName: string,
): boolean {
  const current = cleanVersionString(currentVersion);
  const latest = cleanVersionString(latestTagName);

  const parsedCurrent = semver.valid(semver.coerce(current));
  const parsedLatest = semver.valid(semver.coerce(latest));

  if (!parsedCurrent || !parsedLatest) {
    return false;
  }

  return semver.gt(parsedLatest, parsedCurrent);
}

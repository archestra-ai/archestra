import { normalizeVersion } from "@archestra/shared/version";
import semver from "semver";

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
  const current = normalizeVersion(currentVersion);
  const latest = normalizeVersion(latestTagName);

  const parsedCurrent = semver.valid(current);
  const parsedLatest = semver.valid(semver.coerce(latest));

  if (!parsedCurrent || !parsedLatest) {
    return false;
  }

  return semver.gt(parsedLatest, parsedCurrent);
}

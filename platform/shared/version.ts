/**
 * Give platform release versions exactly one "v" prefix. Preserve build
 * identifiers (including commit SHAs) and semver prerelease/build metadata.
 */
export function normalizeVersion(version: string): string {
  const releaseVersion = version.replace(/^platform-/, "").replace(/^v+/, "");
  const match = SEMVER_PATTERN.exec(releaseVersion);
  return match?.[0] === releaseVersion ? `v${releaseVersion}` : version;
}

// SemVer 2.0: no leading zeroes in core or numeric prerelease identifiers;
// prerelease/build identifiers must be nonempty and contain only ASCII
// alphanumerics and hyphens. Keep malformed build labels untouched.
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

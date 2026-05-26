/**
 * Base container image for the skill sandbox runtime.
 *
 * The image must be Debian-based (bookworm or later) because the sandbox build
 * step always runs apt-get to layer in the baseline toolchain defined by
 * SKILL_SANDBOX_APT_PACKAGES. Using a non-Debian image (Alpine, distroless,
 * etc.) will cause materialization to fail.
 *
 * Admins can override via `ARCHESTRA_SKILLS_SANDBOX_IMAGE` to supply a
 * Debian-based image that already includes uncommon system dependencies needed
 * by their skills.
 *
 * The default points at a uv-flavored Debian base that ships Python 3.12 and
 * matches the `code-runtime` image lineage; node/npm/npx are added by the
 * sandbox's setup layer (see `skill-sandbox-runtime-service.ts`).
 */
export const DEFAULT_SKILL_SANDBOX_IMAGE =
  "ghcr.io/astral-sh/uv:0.9.17-python3.12-bookworm-slim";

/**
 * Apt packages layered on top of the base image to provide a consistent shell
 * toolchain. Custom images must be Debian-based (bookworm or later) because
 * the sandbox build step always runs apt-get to install these packages.
 */
export const SKILL_SANDBOX_APT_PACKAGES = [
  "bash",
  "curl",
  "git",
  "jq",
  "ca-certificates",
  "build-essential",
  "nodejs",
  "npm",
] as const;

/** Root mountpoint inside the container for skill files. */
export const SKILL_SANDBOX_ROOT = "/skills";

/** Home directory for the sandbox user — separate from skill files to avoid tool-cache pollution. */
export const SKILL_SANDBOX_HOME = "/home/sandbox";

/** Non-root user the sandbox runs as. Matches the code-runtime image's uid. */
export const SKILL_SANDBOX_USER = "1000:1000";

/** Per-skill root inside the container, e.g. `/skills/<skill-name>`. */
export function skillRootPath(skillName: string): string {
  if (skillName.includes("/") || skillName.includes("..")) {
    throw new Error(`invalid skill name: ${JSON.stringify(skillName)}`);
  }
  return `${SKILL_SANDBOX_ROOT}/${skillName}`;
}

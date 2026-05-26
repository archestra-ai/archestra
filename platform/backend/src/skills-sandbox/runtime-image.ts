/**
 * Base container image for the skill sandbox runtime.
 *
 * The image must include the toolchains broad skill ecosystems depend on:
 * bash, python3, uv, node, npm, npx, git, curl, jq, and common build basics.
 * Admins can override via `ARCHESTRA_SKILLS_SANDBOX_IMAGE` for skills that
 * need uncommon system dependencies.
 *
 * The default points at a uv-flavored Debian base that ships Python 3.12 and
 * matches the `code-runtime` image lineage; node/npm/npx are added by the
 * sandbox's setup layer (see `skill-sandbox-runtime-service.ts`).
 */
export const DEFAULT_SKILL_SANDBOX_IMAGE =
  "ghcr.io/astral-sh/uv:0.9.17-python3.12-bookworm-slim";

/**
 * Apt packages the sandbox layers on top of the base image so every skill has
 * the same baseline shell toolchain regardless of which image admins pick.
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

/** Non-root user the sandbox runs as. Matches the code-runtime image's uid. */
export const SKILL_SANDBOX_USER = "1000:1000";

/** Per-skill root inside the container, e.g. `/skills/<skill-name>`. */
export function skillRootPath(skillName: string): string {
  return `${SKILL_SANDBOX_ROOT}/${skillName}`;
}

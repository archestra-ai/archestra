/** Root mountpoint inside the container for skill files. */
export const SKILL_SANDBOX_ROOT = "/skills";

/** Home directory for the sandbox user — separate from skill files to avoid tool-cache pollution. */
export const SKILL_SANDBOX_HOME = "/home/sandbox";

/** Where the user's chat attachments are auto-staged inside the container. */
export const SKILL_SANDBOX_ATTACHMENTS_DIR = `${SKILL_SANDBOX_HOME}/attachments`;

/** Per-skill root inside the container, e.g. `/skills/<skill-name>`. */
export function skillRootPath(skillName: string): string {
  if (skillName.includes("/") || skillName.includes("..")) {
    throw new Error(`invalid skill name: ${JSON.stringify(skillName)}`);
  }
  return `${SKILL_SANDBOX_ROOT}/${skillName}`;
}

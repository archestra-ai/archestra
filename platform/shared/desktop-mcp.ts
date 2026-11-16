/**
 * The first version of the `archestra` program whose MCP bridge applies the
 * arguments a user adds to the command of a desktop MCP server. A program
 * from before it does not know the `arguments` key of its config: it starts
 * the command with no arguments of the user. Keep it equal to the `version`
 * of `platform/archestra-cli/Cargo.toml` that first has the arguments.
 */
export const DESKTOP_MCP_ARGUMENTS_MIN_PROGRAM_VERSION = "0.1.2";

/**
 * Whether a device's program applies the arguments of its user, from the
 * version its MCP bridge reported. A device that reported no version, or one
 * that is not a version, does not: nothing says that it knows arguments.
 */
export function programAppliesDesktopMcpArguments(
  version: string | null | undefined,
): boolean {
  const reported = parseProgramVersion(version);
  const first = parseProgramVersion(DESKTOP_MCP_ARGUMENTS_MIN_PROGRAM_VERSION);
  if (!reported || !first) return false;
  const length = Math.max(reported.length, first.length);
  for (let index = 0; index < length; index++) {
    const difference = (reported[index] ?? 0) - (first[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

// === Internal helpers

/**
 * The numbers of a dotted version, or null for a text that is not one. What
 * comes after a `-` or a `+` is not compared: `0.1.2-dev`, the name of a
 * local build, is `0.1.2`.
 */
function parseProgramVersion(
  version: string | null | undefined,
): number[] | null {
  const match = PROGRAM_VERSION_PATTERN.exec(version?.trim() ?? "");
  return match ? match[1].split(".").map(Number) : null;
}

const PROGRAM_VERSION_PATTERN = /^v?(\d{1,9}(?:\.\d{1,9}){0,3})(?:[-+].*)?$/;

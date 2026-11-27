import { SKILL_MANIFEST_INVALID_CODE } from "@archestra/shared";

/** A line of SKILL.md a save was refused for. */
export interface SkillManifestProblem {
  /** The line to fix, counted from 1. */
  line: number;
  /** What is wrong with it, as the API said it. */
  message: string;
  /**
   * The manifest the save sent. The line is a line of this text, so the
   * problem stands only until the text is edited.
   */
  manifest: string;
}

/**
 * The line a refused skill save points at, from the generated API client's
 * error (`{ error: { internal_code, details } }`), or null for any other
 * error.
 */
export function parseSkillManifestProblem(
  error: unknown,
  manifest: string,
): SkillManifestProblem | null {
  if (typeof error !== "object" || error === null) return null;
  const body =
    "error" in error && typeof error.error === "object" && error.error !== null
      ? error.error
      : error;
  if (
    !("internal_code" in body) ||
    body.internal_code !== SKILL_MANIFEST_INVALID_CODE
  ) {
    return null;
  }
  const details = "details" in body ? body.details : undefined;
  const line =
    typeof details === "object" && details !== null && "line" in details
      ? details.line
      : undefined;
  if (typeof line !== "number" || !Number.isInteger(line) || line < 1) {
    return null;
  }
  return {
    line,
    message:
      "message" in body && typeof body.message === "string" ? body.message : "",
    manifest,
  };
}

import type { Skill, SkillFile } from "@/types";

/**
 * Render a skill's SKILL.md body, compatibility note, and resource listing into
 * the XML-framed activation block.
 *
 * This is the payload the `activate_skill` MCP tool returns when a skill is
 * named, and the same block the chat route prepends when a user invokes a skill
 * explicitly via slash command. Keeping it in one place ensures both entry
 * points present skills to the model identically.
 *
 * @see https://agentskills.io/specification
 */
export function formatSkillActivation({
  skill,
  files,
  canRunSandbox,
}: {
  skill: Pick<Skill, "name" | "content" | "compatibility">;
  files: Pick<SkillFile, "path" | "kind">[];
  /**
   * Whether the sandbox tools are usable for this caller (feature enabled +
   * `skill:execute`). When false, omit the sandbox hint so we never point the
   * model at tools that would just refuse.
   */
  canRunSandbox: boolean;
}): string {
  const sandboxHint = canRunSandbox
    ? " To execute a script or shell command from this skill, call " +
      "create_skill_sandbox with this skill's name, then run_skill_command — " +
      "commands run from the skill root so relative paths from the spec " +
      "resolve correctly. Use get_skill_sandbox_artifact to retrieve " +
      "generated files."
    : "";
  const resources =
    files.length > 0
      ? `\n<skill_resources>\n${files
          .map((file) => `${escapeXmlText(file.path)} (${file.kind})`)
          .join("\n")}\n</skill_resources>\n` +
        "Inspect any resource with read_skill_file." +
        sandboxHint
      : "";

  const compatibility = skill.compatibility
    ? `\n<skill_compatibility>${escapeXmlText(skill.compatibility)}</skill_compatibility>\n` +
      "If this environment cannot meet that requirement, tell the user " +
      "and proceed with what is possible."
    : "";

  return (
    `<skill_content name="${escapeXmlAttr(skill.name)}">\n${escapeXmlText(skill.content)}\n</skill_content>` +
    compatibility +
    resources
  );
}

/**
 * Escape a value interpolated into an XML-ish attribute. Skill names and file
 * paths come from imported repos, so a stray `"` or `<` would otherwise let
 * imported content break out of the tag framing the model sees.
 */
export function escapeXmlAttr(value: string): string {
  return escapeXmlText(value).replace(/"/g, "&quot;");
}

/** Escape a value interpolated as text content between XML-ish tags. */
export function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

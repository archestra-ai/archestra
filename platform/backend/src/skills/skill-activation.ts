import {
  buildUserSystemPromptContext,
  type UserSystemPromptContext,
} from "@shared";
import { TeamModel, UserModel } from "@/models";
import { renderSystemPrompt } from "@/templating";
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
 * A `templated` skill has its body rendered through Handlebars with the
 * activating user's context (`{{user.name}}`, `{{currentDate}}`, …), mirroring
 * an agent system prompt. Bundled files (`read_skill_file`) stay literal.
 *
 * @see https://agentskills.io/specification
 */
export function formatSkillActivation({
  skill,
  files,
  canRunSandbox,
  promptContext,
}: {
  skill: Pick<
    Skill,
    "name" | "content" | "compatibility" | "allowedTools" | "templated"
  >;
  files: Pick<SkillFile, "path" | "kind">[];
  /**
   * Whether the sandbox tools are usable for this caller (feature enabled +
   * `skill:execute`). When false, omit the sandbox hint so we never point the
   * model at tools that would just refuse.
   */
  canRunSandbox: boolean;
  /**
   * User context for rendering a `templated` skill body. Build it via
   * {@link buildSkillActivationPromptContext}; a `null`/absent context leaves
   * any `{{…}}` literal rather than failing.
   */
  promptContext?: UserSystemPromptContext | null;
}): string {
  const body =
    skill.templated && promptContext
      ? (renderSystemPrompt(skill.content, promptContext) ?? skill.content)
      : skill.content;
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

  const allowedTools = skill.allowedTools
    ? `\n<skill_allowed_tools>${escapeXmlText(skill.allowedTools)}</skill_allowed_tools>\n` +
      "This skill expects these tools; enable any that are not already active."
    : "";

  return (
    `<skill_content name="${escapeXmlAttr(skill.name)}">\n${escapeXmlText(body)}\n</skill_content>` +
    compatibility +
    allowedTools +
    resources
  );
}

/**
 * Build the user context for rendering a `templated` skill body, mirroring the
 * agent system-prompt path (name, email, team names). Team names are scoped to
 * the activating organization so a skill never sees the user's teams from other
 * orgs. Returns `null` when there is no user/org to resolve, so callers skip the
 * lookups for non-templated skills.
 */
export async function buildSkillActivationPromptContext(params: {
  userId: string | undefined;
  organizationId: string | undefined;
}): Promise<UserSystemPromptContext | null> {
  const { userId, organizationId } = params;
  if (!userId || !organizationId) return null;
  const [user, teams] = await Promise.all([
    UserModel.getById(userId),
    TeamModel.getUserTeamsForOrganization({ userId, organizationId }),
  ]);
  return buildUserSystemPromptContext({
    userName: user?.name ?? "",
    userEmail: user?.email ?? "",
    userTeams: teams.map((team) => team.name),
  });
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

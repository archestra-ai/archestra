import {
  buildUserSystemPromptContext,
  TOOL_DOWNLOAD_FILE_SHORT_NAME,
  TOOL_LOAD_SKILL_SHORT_NAME,
  TOOL_RUN_COMMAND_SHORT_NAME,
  TOOL_UPLOAD_FILE_SHORT_NAME,
  type UserSystemPromptContext,
} from "@archestra/shared";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { TeamModel, UserModel } from "@/models";
import { renderSystemPrompt } from "@/templating";
import type { Skill, SkillFile } from "@/types";

/**
 * Render a skill's SKILL.md body, compatibility note, and resource listing into
 * the XML-framed activation block.
 *
 * This is the payload the `load_skill` MCP tool returns when called with just a
 * name, and the same block the chat route prepends when a user invokes a skill
 * explicitly via slash command. Keeping it in one place ensures both entry
 * points present skills to the model identically.
 *
 * A `templated` skill has its body rendered through Handlebars with the
 * activating user's context (`{{user.name}}`, `{{currentDate}}`, …), mirroring
 * an agent system prompt. Bundled files (`load_skill` with a path) stay literal.
 *
 * Terminology for every model-facing skill text (tool descriptions, catalog
 * and activation blocks): a skill is *loaded* (the `load_skill` call), which
 * brings its instructions into context and *mounts* its files under `/skills`
 * in the sandbox. The sandbox is "the conversation's sandbox" in tool
 * descriptions and "your sandbox" in second-person prompt text.
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
   * `sandbox:execute`). When false, omit the sandbox hint so we never point the
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
  const skillRoot = `/skills/${neutralizeFrameTags(skill.name)}`;
  const runCommand = archestraMcpBranding.getToolName(
    TOOL_RUN_COMMAND_SHORT_NAME,
  );
  const downloadFile = archestraMcpBranding.getToolName(
    TOOL_DOWNLOAD_FILE_SHORT_NAME,
  );
  const uploadFile = archestraMcpBranding.getToolName(
    TOOL_UPLOAD_FILE_SHORT_NAME,
  );
  const loadSkill = archestraMcpBranding.getToolName(
    TOOL_LOAD_SKILL_SHORT_NAME,
  );
  const sandboxHint = canRunSandbox
    ? ` This skill is mounted in your sandbox at ${skillRoot}. Run a bundled ` +
      `script via ${runCommand} (\`python3 ${skillRoot}/<script>\`); pass cwd: ${skillRoot} ` +
      "when a script reads bundled files by relative path. Direct outputs to " +
      "absolute paths under /home/sandbox — a script computing paths relative to " +
      `its own file writes under ${skillRoot}, not your cwd. Use ${downloadFile} to ` +
      `retrieve generated files, ${uploadFile} to add inputs.`
    : "";
  const resources =
    files.length > 0
      ? `\n<skill_resources>\n${files
          .map((file) => `${neutralizeFrameTags(file.path)} (${file.kind})`)
          .join("\n")}\n</skill_resources>\n` +
        `Inspect any resource with ${loadSkill} (passing its path) before ` +
        "re-implementing — prefer importing and running the skill's own modules " +
        "over rewriting them." +
        sandboxHint
      : "";

  const compatibility = skill.compatibility
    ? `\n<skill_compatibility>${neutralizeFrameTags(skill.compatibility)}</skill_compatibility>\n` +
      "If this environment cannot meet that requirement, tell the user " +
      "and proceed with what is possible."
    : "";

  const allowedTools = skill.allowedTools
    ? `\n<skill_allowed_tools>${neutralizeFrameTags(skill.allowedTools)}</skill_allowed_tools>\n` +
      "This skill expects these tools; enable any that are not already active."
    : "";

  return (
    `<skill_content name="${escapeXmlAttr(skill.name)}">\n${neutralizeFrameTags(body)}\n</skill_content>` +
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
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Defang platform prompt-frame tags in untrusted text shown to the model.
 *
 * The activation/catalog/file blocks are prompt frames, not parseable XML —
 * the model reads their content literally, so escaping every `<`/`>` corrupts
 * code samples (heredocs, comparisons, generics) the model is expected to run
 * verbatim. The only thing imported content must not do is open or close one
 * of the platform's own frames: those exact tag names are neutralized (the
 * `<` becomes `&lt;`) and everything else passes through untouched.
 *
 * Lossy on purpose: a body that legitimately contains the literal text
 * `&lt;/skill_content>` becomes indistinguishable from a neutralized
 * injection — both render defanged, so nothing can ever close the frame.
 */
export function neutralizeFrameTags(value: string): string {
  return value.replace(FRAME_TAG_PATTERN, "&lt;");
}

/**
 * Every XML-ish frame tag this pipeline emits around model-facing skill text:
 * the activation block (`skill_content`, `skill_resources`,
 * `skill_compatibility`, `skill_allowed_tools`), the `load_skill` file framing
 * (`skill_file`), and the catalog (`available_skills`, `skill`). Adding a new
 * frame anywhere in skill prompts requires registering its tag here.
 *
 * Deliberately scoped to the skill pipeline's own frames: tags other parts of
 * the prompt assembly may use (tool-result or attachment framing, reminder
 * blocks, …) pass through, exactly as they do in every other untrusted text
 * surface (tool results, file contents read in the sandbox).
 */
const FRAME_TAG_NAMES = [
  "skill_content",
  "skill_resources",
  "skill_compatibility",
  "skill_allowed_tools",
  "skill_file",
  "available_skills",
  "skill",
];

// matches the `<` of an opening or closing frame tag, case-insensitively. The
// tag name must follow the bracket immediately — the platform never emits
// whitespace inside a frame tag, and tolerating it would both over-defang
// innocent text (`a < skill.level`) and, with quantifiers around the slash,
// open a quadratic-backtracking hole on `<` + long whitespace runs. The name
// must also END like a tag name does in our frames (whitespace, `>`, `/`, or
// end of text), so `<skill-level>`/`<skill.file>` stay literal. The lookahead
// keeps the tag name in place so only the bracket is defanged.
const FRAME_TAG_PATTERN = new RegExp(
  `<(?=/?(?:${FRAME_TAG_NAMES.join("|")})(?=[\\s/>]|$))`,
  "gi",
);

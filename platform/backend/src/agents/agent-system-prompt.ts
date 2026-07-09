import {
  type ArchestraToolShortName,
  buildUserSystemPromptContext,
  PROJECTS_FILE_ARCHESTRA_TOOL_SHORT_NAMES,
  TOOL_DOWNLOAD_FILE_SHORT_NAME,
  TOOL_LOAD_SKILL_SHORT_NAME,
  TOOL_READ_FILE_SHORT_NAME,
  TOOL_RUN_COMMAND_SHORT_NAME,
  TOOL_RUN_TOOL_SHORT_NAME,
  TOOL_SAVE_FILE_SHORT_NAME,
  TOOL_SCAFFOLD_APP_SHORT_NAME,
  TOOL_SEARCH_FILES_SHORT_NAME,
  TOOL_SEARCH_TOOLS_SHORT_NAME,
  TOOL_UPLOAD_FILE_SHORT_NAME,
} from "@archestra/shared";
import type { Tool } from "ai";
import { archestraMcpBranding } from "@/archestra-mcp-server";
import { TeamModel, UserModel } from "@/models";
import { buildSkillCatalogPrompt } from "@/skills/skill-catalog-prompt";
import {
  SKILL_SANDBOX_ATTACHMENTS_DIR,
  SKILL_SANDBOX_HOME,
} from "@/skills-sandbox/runtime-image";
import {
  promptNeedsRendering,
  renderSystemPrompt,
  type UserSystemPromptContext,
} from "@/templating";
import type { ToolExposureMode } from "@/types";

/** @public — canonical instruction text, asserted by the assembler tests. */
export const TOOL_DENIAL_INSTRUCTION =
  "When a tool execution is not approved by the user, do not retry it. Explain what happened and ask the user what they'd like to do instead.";

/** @public — canonical preamble for a project's instructions, asserted by the
 * assembler tests. */
export const PROJECT_INSTRUCTIONS_PREFIX =
  "The following are the project's instructions. Treat them as standing guidance for this conversation, second only to the user's direct messages.";

/** @public — canonical instruction text, asserted by the assembler tests. */
export const TOOL_UI_RESULT_INSTRUCTION =
  "When a tool result includes a UI resource, it means an interactive UI was rendered for the user. Respond with at most one brief sentence. Never describe, list, or explain what the UI shows.";

/**
 * Compose an agent's system prompt: render its base prompt (with Handlebars
 * user context when needed), eagerly list its loadable skills, and append the
 * tool-behavior instructions implied by its tool set and exposure mode. Shared
 * by the interactive chat path and the autonomous A2A path so both produce the
 * same prompt from the same inputs.
 */
export async function buildAgentSystemPrompt(params: {
  agent: {
    systemPrompt: string | null;
    toolExposureMode: ToolExposureMode;
  };
  mcpTools: Record<string, Tool>;
  organizationId: string;
  userId: string;
  agentId: string;
  /**
   * Pre-resolved invoking user. The chat path has it in hand; the A2A path
   * omits it and it is fetched on demand only when the prompt uses templating.
   */
  user?: { name: string; email: string };
  /** Context injected by SessionStart hooks (chat only), appended last. */
  hookSessionContext?: string;
  /**
   * The project's instructions (chat in a project only), injected just after the
   * agent's own prompt. Empty/absent leaves the prompt unchanged.
   */
  projectInstructions?: string;
}): Promise<string | undefined> {
  const {
    agent,
    mcpTools,
    organizationId,
    userId,
    agentId,
    user,
    hookSessionContext,
    projectInstructions,
  } = params;

  const renderedPrompt = await renderAgentPrompt({
    systemPrompt: agent.systemPrompt,
    organizationId,
    userId,
    user,
  });

  const toolLoadingInstructions =
    agent.toolExposureMode === "search_and_run_only"
      ? buildLoadToolsWhenNeededSystemPrompt()
      : null;

  const toolResultInstructions =
    Object.keys(mcpTools).length > 0 ? TOOL_UI_RESULT_INSTRUCTION : null;

  // eagerly list the agent's skills in the prompt (like Claude Code /
  // opencode), but only when the agent can actually load them.
  const skillCatalogPrompt =
    archestraMcpBranding.getToolName(TOOL_LOAD_SKILL_SHORT_NAME) in mcpTools
      ? await buildSkillCatalogPrompt({ organizationId, userId, agentId })
      : null;

  // Scope file-handling guidance to what the agent can actually do: emit it only
  // when the sandbox and/or persistent-file tools are in its tool set, and word
  // it from the tools actually present. Keyed off mcpTools (already RBAC- and
  // availability-filtered upstream), not a separate availability probe.
  const fileHandlingInstruction = buildFileHandlingInstruction(mcpTools);

  const projectInstructionsPrompt = projectInstructions
    ? `${PROJECT_INSTRUCTIONS_PREFIX}\n\n${projectInstructions}`
    : null;

  return (
    [
      toolLoadingInstructions,
      renderedPrompt,
      projectInstructionsPrompt,
      skillCatalogPrompt,
      fileHandlingInstruction,
      TOOL_DENIAL_INSTRUCTION,
      toolResultInstructions,
      hookSessionContext,
    ]
      .filter(Boolean)
      .join("\n\n") || undefined
  );
}

// ===== Internal helpers =====

async function renderAgentPrompt(params: {
  systemPrompt: string | null;
  organizationId: string;
  userId: string;
  user?: { name: string; email: string };
}): Promise<string | null> {
  const { systemPrompt, organizationId, userId, user } = params;

  // Build template context only when prompts use Handlebars syntax.
  let promptContext: UserSystemPromptContext | null = null;
  if (promptNeedsRendering(systemPrompt)) {
    const [resolvedUser, userTeams] = await Promise.all([
      user ?? UserModel.getById(userId),
      TeamModel.getUserTeamsForOrganization({ userId, organizationId }),
    ]);
    promptContext = buildUserSystemPromptContext({
      userName: resolvedUser?.name ?? "",
      userEmail: resolvedUser?.email ?? "",
      userTeams: userTeams.map((t) => t.name),
    });
  }

  return renderSystemPrompt(systemPrompt, promptContext);
}

/**
 * File-handling guidance, assembled from the file tools the agent actually has.
 * Returns null when it has none. Two surfaces drive the wording:
 *  - the sandbox runtime (`run_command` + `download_file`/`upload_file`): a
 *    scratch Linux workspace the user cannot see;
 *  - the persistent files (`search_files`/`read_file`/`save_file`/…): the
 *    conversation's Files panel, the only place the user sees a file.
 * Every referenced tool is guarded by its presence, so the block never names a
 * tool the agent can't call. Tool names are branded via `archestraMcpBranding`.
 */
function buildFileHandlingInstruction(
  mcpTools: Record<string, Tool>,
): string | null {
  const has = (shortName: ArchestraToolShortName): boolean =>
    archestraMcpBranding.getToolName(shortName) in mcpTools;

  const hasSandbox = has(TOOL_RUN_COMMAND_SHORT_NAME);
  const hasPersistentFiles = PROJECTS_FILE_ARCHESTRA_TOOL_SHORT_NAMES.some(has);
  if (!hasSandbox && !hasPersistentFiles) {
    return null;
  }

  const runCommand = archestraMcpBranding.getToolName(
    TOOL_RUN_COMMAND_SHORT_NAME,
  );
  const downloadFile = archestraMcpBranding.getToolName(
    TOOL_DOWNLOAD_FILE_SHORT_NAME,
  );
  const uploadFile = archestraMcpBranding.getToolName(
    TOOL_UPLOAD_FILE_SHORT_NAME,
  );
  const searchFiles = archestraMcpBranding.getToolName(
    TOOL_SEARCH_FILES_SHORT_NAME,
  );
  const readFile = archestraMcpBranding.getToolName(TOOL_READ_FILE_SHORT_NAME);
  const saveFile = archestraMcpBranding.getToolName(TOOL_SAVE_FILE_SHORT_NAME);

  const paragraphs: string[] = [];

  if (hasSandbox) {
    paragraphs.push(
      `You have a code execution environment: \`${runCommand}\` runs shell commands and Python in a persistent Linux workspace at \`${SKILL_SANDBOX_HOME}\`. Use it to compute, transform files, run scripts, or fetch data when the other tools don't cover the task. Files there persist across commands within this conversation but the user cannot see them. Files the user attached are staged under \`${SKILL_SANDBOX_ATTACHMENTS_DIR}/\` — the on-disk name may be sanitized, so \`ls\` that directory to find them.`,
    );
    paragraphs.push(
      `Skill scripts and instructions may assume packages or system binaries this workspace does not have. When a command fails on a missing module or binary, install it or work around it — for example, compute the values directly in Python instead of relying on the missing tool — and make sure the deliverable reflects the workaround, not the broken intermediate state.`,
    );
  }

  if (hasPersistentFiles) {
    const deliver = hasSandbox
      ? `To hand a file to the user it must land there: compose inline content with \`${saveFile}\`, or export something already on the sandbox disk (a script's output, an attachment) with \`${downloadFile}\` by its path. Never read a file's bytes back and paste them into your reply or \`${saveFile}\` — export by path so the bytes never pass through your context. Use \`${uploadFile}\` to pull a persistent or inline file into the sandbox to process it.`
      : `To hand a file to the user, write it to the persistent files with \`${saveFile}\`; it then appears in their Files panel.`;
    paragraphs.push(
      `The files the user can see live in the conversation's persistent files (their Files panel), not in the sandbox workspace. ${deliver}`,
    );
  } else if (hasSandbox) {
    // Sandbox runtime without the persistent-file tools (Projects off): the only
    // way to surface a file to the user is to export it from the sandbox.
    paragraphs.push(
      `To hand a file to the user, export it from the sandbox with \`${downloadFile}\` by its path; its bytes are recorded for the user's Files panel without passing through your reply.`,
    );
  }

  paragraphs.push(
    `When a request implies a deliverable — "write/create/save a report, doc, script, dataset", or output longer than a short snippet — produce a file rather than only printing it in chat. A saved file appears in the user's Files panel automatically; reference it by name with a one-line summary rather than restating its contents. For a quick answer, just reply.`,
  );

  if (hasPersistentFiles) {
    const readBinary = hasSandbox
      ? ` For other binary types (PDF, docx, xlsx, archives), \`${uploadFile}\` it into the sandbox and inspect with \`${runCommand}\`.`
      : "";
    paragraphs.push(
      `If the user points at a file they did not attach this turn — "my report", "the doc from earlier", "update the spreadsheet" — it is in the persistent files, not on the sandbox disk. Call \`${searchFiles}\` first (omit the query to list them; matching is on filename only, so list and scan when the description isn't a filename), then act on the \`ref\` it returns; don't \`ls ${SKILL_SANDBOX_HOME}\` for it, since files the user dropped into the Files panel never appear there. To read it, \`${readFile}\` returns text as numbered lines and PNG/JPEG/WebP/GIF inline, straight from the persistent store.${readBinary} If a text or image attachment is already visible to you inline, use it as-is rather than re-fetching it.`,
    );
  }

  return paragraphs.join("\n\n");
}

function buildLoadToolsWhenNeededSystemPrompt(): string {
  const searchToolsName = archestraMcpBranding.getToolName(
    TOOL_SEARCH_TOOLS_SHORT_NAME,
  );
  const runToolName = archestraMcpBranding.getToolName(
    TOOL_RUN_TOOL_SHORT_NAME,
  );
  // Naming scaffold_app verbatim satisfies run_tool's names-seen-verbatim
  // gate, so the model can start an app build without a search_tools
  // round-trip. Emitted for every search_and_run_only agent regardless of
  // assignment: an agent that cannot dispatch it gets a clear refusal from
  // run_tool, which costs one turn in a rare configuration — cheaper than
  // mirroring the dispatch gate's assignment/RBAC logic here.
  const scaffoldAppName = archestraMcpBranding.getToolName(
    TOOL_SCAFFOLD_APP_SHORT_NAME,
  );

  const base = `Some available tools are not listed upfront and must be discovered. If the visible tools do not fit the task, call \`${searchToolsName}\` to find relevant tools, then call \`${runToolName}\` with a tool name it returned. Only pass \`${runToolName}\` a tool name that \`${searchToolsName}\` returned or that appeared verbatim earlier in this conversation; if you do not have an exact name, call \`${searchToolsName}\` first.

\`${runToolName}\` takes exactly two arguments: \`tool_name\` (the exact name) and \`tool_args\` (an object holding the target tool's own parameters). For example, to call a tool \`maps__set_marker\` that takes a name and a \`coordinates\` object, call \`${runToolName}\` with \`tool_name: "maps__set_marker"\` and \`tool_args: { "name": "home", "coordinates": { "lat": 51.5, "lng": -0.1 } }\` — keep each parameter under its own key in \`tool_args\` and preserve nested objects as-is; do not flatten their fields into \`tool_args\`. Equally, pass strings, numbers, booleans, and arrays directly as parameter values — never wrap a value in a single-key object. The \`${searchToolsName}\` parameter signatures are summaries; if a \`${runToolName}\` call is rejected as invalid, the error describes the expected input — use it to correct the call.`;

  return `${base}

When the user asks to make, build, or create an app or interactive UI, never write the app's code in your chat reply: start by calling \`${runToolName}\` with \`tool_name: "${scaffoldAppName}"\`, and find the follow-up app tools with \`${searchToolsName}\`.`;
}

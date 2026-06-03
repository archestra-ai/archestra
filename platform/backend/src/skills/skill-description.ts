import { parseFullToolName, SKILL_ARCHESTRA_TOOL_SHORT_NAMES } from "@shared";
import { createLLMModel } from "@/clients/llm-client";
import logger from "@/logging";
import { generateTaggedText } from "@/utils/generate-tagged-text";
import { resolveAgentLlmOrDefault } from "@/utils/llm-resolution";

/**
 * Suggest a skill `description` from a source agent during agent→skill
 * migration. The description is required and drives activation, so when the
 * agent has nothing usable the conversion dialog otherwise falls back to the
 * agent name. Runs over the org's best-available model (the agent's own model
 * if set) via {@link generateTaggedText} — no agent record, no built-in
 * subagent, no persistence. Returns null when no LLM is configured or
 * generation fails, so callers can fall back to "write one manually" rather
 * than block the conversion.
 *
 * @see {@link agentToSkill}
 */

/**
 * The subset of an agent this reads. A full agent assigns to it.
 *
 * @public — exported for testability
 */
export interface DescribableAgent {
  id: string;
  name: string;
  description: string | null;
  systemPrompt: string | null;
  tools: readonly { name: string }[];
  suggestedPrompts: readonly { summaryTitle: string; prompt: string }[];
  /** LLM selection fields, used to resolve which model to call. */
  llmApiKeyId: string | null;
  modelId: string | null;
}

export async function suggestSkillDescription(params: {
  agent: DescribableAgent;
  organizationId: string;
  userId: string;
}): Promise<string | null> {
  const { agent, organizationId, userId } = params;

  const llm = await resolveAgentLlmOrDefault({ agent, organizationId, userId });

  const model = createLLMModel({
    provider: llm.provider,
    apiKey: llm.apiKey,
    modelName: llm.modelName,
    baseUrl: llm.baseUrl,
    // attribute the proxy call to the source agent; createLLMModel's `agentId`
    // is just a logging/virtual-key label, not an agent the call runs "as".
    agentId: agent.id,
    userId,
    source: "skill:description_generation",
  });

  try {
    return await generateTaggedText({
      model,
      tag: "description",
      system: SKILL_DESCRIPTION_SYSTEM_PROMPT,
      prompt: buildSkillDescriptionPrompt(agent),
      maxOutputTokens: 512,
      sanitize: sanitizeDescription,
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to generate skill description");
    return null;
  }
}

/**
 * Normalize a generated description into a single clean line: collapse
 * whitespace, drop wrapping quotes/backticks a model may add, and cap length so
 * a runaway response can't overflow the description field.
 *
 * @public — exported for testability
 */
export function sanitizeDescription(raw: string): string {
  const oneLine = raw.replace(/\s+/g, " ").trim();
  const unquoted = oneLine.replace(/^["'`]+|["'`]+$/g, "").trim();
  return unquoted.slice(0, MAX_DESCRIPTION_CHARS);
}

/**
 * Render the agent into the user-message half of the description prompt. Pure,
 * so the prompt's shape is unit-tested directly without an LLM.
 *
 * @public — exported for testability
 */
export function buildSkillDescriptionPrompt(agent: DescribableAgent): string {
  const sections: string[] = [`Agent name: ${agent.name}`];

  const description = agent.description?.trim();
  if (description) {
    sections.push(`Existing description: ${description}`);
  }

  const systemPrompt = agent.systemPrompt?.trim();
  if (systemPrompt) {
    sections.push(
      `System prompt:\n${truncate(systemPrompt, MAX_PROMPT_CHARS)}`,
    );
  }

  const toolNames = agent.tools
    .map((tool) => tool.name)
    .filter((name) => !isSkillRuntimeTool(name));
  if (toolNames.length > 0) {
    sections.push(`Tools it uses: ${toolNames.join(", ")}`);
  }

  if (agent.suggestedPrompts.length > 0) {
    const examples = agent.suggestedPrompts
      .map((prompt) => `- ${prompt.summaryTitle}: ${prompt.prompt}`)
      .join("\n");
    sections.push(`Example prompts:\n${examples}`);
  }

  return sections.join("\n\n");
}

// ===== Internal =====

/** Agent Skill spec caps `description` at 1024 characters. */
const MAX_DESCRIPTION_CHARS = 1024;

const SKILL_DESCRIPTION_SYSTEM_PROMPT = `You write the "description" field of an Agent Skill (a reusable instruction set an AI agent activates on demand).

The description is the only signal an agent uses to decide whether to activate the skill, so it must say what the skill does and when to use it.

Rules:
- One sentence, at most 160 characters.
- Start with a verb describing the capability (e.g. "Summarizes...", "Drafts...", "Reviews...").
- No agent/skill jargon, no "this skill", no markdown, no quotes.
- Base it only on the provided agent details; do not invent capabilities.`;

const MAX_PROMPT_CHARS = 4000;

const SKILL_RUNTIME_TOOL_SHORT_NAMES: ReadonlySet<string> = new Set(
  SKILL_ARCHESTRA_TOOL_SHORT_NAMES,
);

function isSkillRuntimeTool(toolName: string): boolean {
  const { toolName: shortName } = parseFullToolName(toolName);
  return SKILL_RUNTIME_TOOL_SHORT_NAMES.has(shortName);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

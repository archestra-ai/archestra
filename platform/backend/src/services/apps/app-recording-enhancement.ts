import { APP_RECORDING_DESCRIPTION_MAX_CHARS } from "@archestra/shared";
import { createLLMModel } from "@/clients/llm-client";
import logger from "@/logging";
import { generateTaggedText } from "@/utils/generate-tagged-text";
import { resolveAgentLlmOrDefault } from "@/utils/llm-resolution";

/**
 * Draft the AI enhancement for a recorded app-building session: a one-line
 * gallery-card app description, one consolidated build prompt — the initial
 * ask merged with every refinement, written as if the builder had asked for
 * the final app in one go — and one closing agent response presenting the
 * built app (the enhanced replay shows it in place of the captured assistant
 * prose while the tool activity replays as-is). All are DRAFTS the builder
 * edits by hand before applying; each comes back null when no LLM is
 * configured or generation fails, so the caller can fall back (e.g. pre-draft
 * the description from the app name) rather than block. Runs over the org's
 * default model via the LLM proxy, one call per field
 * ({@link generateTaggedText} — tags, not JSON, for cross-model reliability).
 */
export async function draftRecordingEnhancement(params: {
  appName: string;
  conversationId: string;
  /** The agent connected to the chat session: generation implicitly runs over
   * its configured LLM (org default when it has none / when null). */
  agent: {
    id: string;
    llmApiKeyId: string | null;
    modelId: string | null;
  } | null;
  messages: unknown[];
  organizationId: string;
  userId: string;
}): Promise<{
  description: string | null;
  prompt: string | null;
  response: string | null;
  category: string | null;
}> {
  const transcript = renderTranscript(params.messages);
  if (!transcript) {
    return { description: null, prompt: null, response: null, category: null };
  }

  const llm = await resolveAgentLlmOrDefault({
    agent: params.agent,
    organizationId: params.organizationId,
    userId: params.userId,
    conversationId: params.conversationId,
  });
  const model = createLLMModel({
    provider: llm.provider,
    apiKey: llm.apiKey,
    modelName: llm.modelName,
    baseUrl: llm.baseUrl,
    agentId: params.agent?.id ?? params.conversationId,
    userId: params.userId,
    sessionId: params.conversationId,
    source: "app:recording_enhancement",
  });

  const context = `App name: ${params.appName}\n\nChat session transcript:\n${transcript}`;
  try {
    const [description, prompt, response, category] = await Promise.all([
      generateTaggedText({
        model,
        tag: "description",
        system: DESCRIPTION_SYSTEM_PROMPT,
        prompt: context,
        // One sentence, capped at APP_RECORDING_DESCRIPTION_MAX_CHARS — a
        // couple of hundred tokens is already generous, and providers that
        // bill on reserved output make a large ceiling cost real money.
        maxOutputTokens: 256,
        sanitize: sanitizeOneLine,
      }),
      generateTaggedText({
        model,
        tag: "build_prompt",
        system: BUILD_PROMPT_SYSTEM_PROMPT,
        prompt: context,
        // A one-sentence ask needs no room to sprawl; a generous ceiling is
        // itself an invitation to write the spec this must never be.
        maxOutputTokens: 512,
        sanitize: sanitizeHumanAsk,
      }),
      generateTaggedText({
        model,
        tag: "closing_response",
        system: CLOSING_RESPONSE_SYSTEM_PROMPT,
        prompt: context,
        maxOutputTokens: 4096,
      }),
      generateTaggedText({
        model,
        tag: "category",
        system: CATEGORY_SYSTEM_PROMPT,
        prompt: context,
        maxOutputTokens: 1024,
        sanitize: sanitizeCategory,
      }),
    ]);
    return { description, prompt, response, category };
  } catch (error) {
    logger.error({ err: error }, "Failed to draft recording enhancement");
    return { description: null, prompt: null, response: null, category: null };
  }
}

// =============================================================================
// Internal helpers
// =============================================================================

const DESCRIPTION_SYSTEM_PROMPT =
  "You write the one-line description shown under an app's title on a public " +
  "gallery card. Given the app's name and the chat session in which it was " +
  "built, write ONE punchy line saying what the app shows or does and what " +
  "makes it worth opening. The line renders directly under the app's name, " +
  "so the name must NEVER appear in it — not opening the line, not anywhere " +
  "in it. Lead with the concrete subject — the data, the view, the job it " +
  "does — never with filler like 'This app' or a bare 'It'. Name the data " +
  "sources or tools the session actually used when they matter (e.g. 'from " +
  "Gmail and Sheets'). A tight sentence fragment beats a full sentence. " +
  "Plain concrete language, no marketing fluff, no quotes. Hard limit of " +
  `${APP_RECORDING_DESCRIPTION_MAX_CHARS} characters — never exceed it. ` +
  "Target style: 'Interactive 3D CAD viewer with live dimensions and view " +
  "presets.' / 'Every open PR across the org, sorted by how long it's been " +
  "waiting.' / 'Unpaid invoices from Gmail and Sheets, with one-click chase " +
  "reminders.' / 'Who owes whom a round — the ledger the London office " +
  "actually uses.'";

/** Word ceiling for the drafted ask — a chat message, not a document. */
const HUMAN_ASK_MAX_WORDS = 70;

const CLOSING_RESPONSE_SYSTEM_PROMPT =
  "You write the agent's ONE closing reply for a replayed app-building " +
  "session: the agent's real tool activity replays first, then this single " +
  "message hands the finished app over. This is the DETAILED half of the " +
  "exchange — the person's ask above it is one casual sentence, and this " +
  "reply is where the substance goes.\n\n" +
  "Write it in the agent's voice: open with one short line saying it is " +
  "built and what it is, then walk through what it actually does — the " +
  "concrete features the session produced, one short '- ' bullet each " +
  "(three to six, only ones the session really built). Name the data " +
  "sources and tools the app calls where they matter. Close with one line " +
  "on how to use it if that is not obvious. Plain, warm, concrete; no " +
  "headings, no meta commentary about the session or the building process.";

const BUILD_PROMPT_SYSTEM_PROMPT =
  "Write the ONE casual message a person would type to ask for this app. " +
  "Output that message and nothing else.\n\n" +
  "It must read like someone talking to an assistant, not like a " +
  "specification. Exactly this shape:\n\n" +
  "'Build me an app that shows every open pull request across our repos as " +
  "a review queue, sorted by how long each has been waiting, grouped by " +
  "reviewer, with anything older than 3 days flagged and a button to ping " +
  "the reviewer in Slack.'\n\n" +
  "'Build me a tracker for unpaid invoices that pulls them out of my Gmail " +
  "and the billing sheet, shows me who is overdue and by how long, and lets " +
  "me fire off a chase email in one click.'\n\n" +
  "Hard rules:\n" +
  "- ONE paragraph, one or two sentences, 60 words maximum.\n" +
  "- First person, present tense, plain speech. Start with the ask itself.\n" +
  "- NEVER write a spec. No bullet points, no numbered requirements, no " +
  "'Features:' section, no headings, no markdown of any kind, no line " +
  "breaks. A person typing into a chat box writes none of those.\n" +
  "- Do not name the app or quote a title. Describe what it does.\n" +
  "- Say what it shows and the two or three details that define it, and name " +
  "the data sources it should use. Nothing more.\n\n" +
  "The session refined the app over several messages: fold those refinements " +
  "into the single ask as though the person had known to ask up front, and " +
  "drop dead ends that were reversed along with any incidental detail nobody " +
  "would have thought to request.";

const CATEGORY_SYSTEM_PROMPT =
  "You file an app under ONE gallery category. Given the app's name and the " +
  "chat session in which it was built, answer with a single category and " +
  "nothing else. Prefer one of: Development, Engineering, Finance, Sales, " +
  "Marketing, Design, Productivity, Data, Operations, Support, Research, " +
  "Games, Weird. Use another single word only when none of those fits. " +
  "Title Case, one or two words, no punctuation, no explanation.";

/** Bounds so a marathon session still fits one utility-generation request. */
const MAX_TRANSCRIPT_CHARS = 24_000;
const MAX_TURN_CHARS = 2_000;

/** One short label, whatever shape the model answered in. */
function sanitizeCategory(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .replace(/^["'`]+|["'`.]+$/g, "")
    .trim()
    .split(" ")
    .slice(0, 2)
    .join(" ")
    .slice(0, 40);
}

/**
 * Force a drafted build prompt back into something a person would have typed.
 *
 * Instructions alone do not hold: models drift into writing a requirements
 * document — an opening line, then "Features:" and a bullet list — which is the
 * opposite of the one casual ask this stands in for. The human ask is always
 * the prose BEFORE that drift, so the spec tail is cut rather than flattened
 * (flattening a bullet list into a paragraph just yields a run-on sentence).
 *
 * @public — exported for testability
 */
export function sanitizeHumanAsk(raw: string): string {
  let text = raw.trim();
  // A spec section header, or the first bullet/numbered line, marks where the
  // model stopped writing like a person.
  const specHeader =
    /(?:^|\n)\s*(?:features?|requirements?|details?|specs?|notes?|acceptance criteria)\b\s*:?\s*(?:\n|$)/i;
  const headerAt = text.search(specHeader);
  if (headerAt > 0) text = text.slice(0, headerAt);
  const listAt = text.search(/(?:^|\n)\s*(?:[-*+•]|\d+[.)])\s+\S/);
  if (listAt > 0) text = text.slice(0, listAt);

  text = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, "")
    // Emphasis, code ticks and quote marks — a chat message carries none of
    // them, and a quoted app title is the tell of a spec.
    .replace(/[*_`>"“”]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const words = text.split(" ").filter(Boolean);
  if (words.length <= HUMAN_ASK_MAX_WORDS) return text;
  // Over the cap: keep whole sentences, never a dangling clause.
  const capped = words.slice(0, HUMAN_ASK_MAX_WORDS).join(" ");
  const lastSentenceEnd = Math.max(
    capped.lastIndexOf(". "),
    capped.lastIndexOf("! "),
    capped.lastIndexOf("? "),
  );
  return lastSentenceEnd > 0
    ? capped.slice(0, lastSentenceEnd + 1)
    : `${capped.replace(/[,;:]$/, "")}.`;
}

/** The prompt already demands the shared ceiling; the slice is the backstop
 * for a model that ignores it, so the UI never has to trim. */
function sanitizeOneLine(raw: string): string {
  const oneLine = raw.replace(/\s+/g, " ").trim();
  return oneLine
    .replace(/^["'`]+|["'`]+$/g, "")
    .slice(0, APP_RECORDING_DESCRIPTION_MAX_CHARS);
}

/**
 * Render the conversation into "User:/Assistant:" turns with tool-call
 * markers, capped per turn and overall (newest turns win the budget — they
 * carry the refinements the consolidated prompt must include).
 */
function renderTranscript(messages: unknown[]): string {
  const turns: string[] = [];
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const message = raw as { role?: unknown; parts?: unknown };
    if (message.role !== "user" && message.role !== "assistant") continue;
    const pieces: string[] = [];
    for (const part of Array.isArray(message.parts) ? message.parts : []) {
      if (!part || typeof part !== "object") continue;
      const candidate = part as {
        type?: unknown;
        text?: unknown;
        toolName?: unknown;
      };
      if (typeof candidate.type !== "string") continue;
      if (candidate.type === "text" && typeof candidate.text === "string") {
        const text = candidate.text.trim();
        if (text) pieces.push(text.slice(0, MAX_TURN_CHARS));
      } else if (candidate.type === "dynamic-tool") {
        if (typeof candidate.toolName === "string") {
          pieces.push(`[tool: ${candidate.toolName}]`);
        }
      } else if (candidate.type.startsWith("tool-")) {
        pieces.push(`[tool: ${candidate.type.slice("tool-".length)}]`);
      }
    }
    if (pieces.length === 0) continue;
    const label = message.role === "user" ? "User" : "Assistant";
    turns.push(`${label}: ${pieces.join("\n")}`);
  }
  // Keep the newest turns when over budget.
  let total = 0;
  const kept: string[] = [];
  for (let i = turns.length - 1; i >= 0; i--) {
    total += turns[i].length + 2;
    if (total > MAX_TRANSCRIPT_CHARS) break;
    kept.unshift(turns[i]);
  }
  return kept.join("\n\n");
}

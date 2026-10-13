import type { PartialUIMessage } from "../types";
import type { Interaction, InteractionUtils } from "./common";

type JevInteraction = Extract<Interaction, { type: "jev:decisions" }>;

/**
 * Interaction class for Jev decisions. A decision has no conversation or tool
 * calls: the state is shown as the user turn and the answers as the reply, one
 * line per question with the winning option and its probability.
 */
class JevDecisionsInteraction implements InteractionUtils {
  modelName: string;
  private interaction: JevInteraction;

  constructor(interaction: Interaction) {
    this.interaction = interaction as JevInteraction;
    this.modelName = interaction.model ?? "unknown";
  }

  isLastMessageToolCall(): boolean {
    return false;
  }

  getLastToolCallId(): string | null {
    return null;
  }

  getToolNamesUsed(): string[] {
    return [];
  }

  getToolNamesRefused(): string[] {
    return [];
  }

  getToolNamesRequested(): string[] {
    return [];
  }

  getToolRefusedCount(): number {
    return 0;
  }

  getLastUserMessage(): string {
    const state = asRecord(this.interaction.request)?.state;
    if (state === undefined) return "";
    return typeof state === "string" ? state : JSON.stringify(state);
  }

  getLastAssistantResponse(): string {
    const answers = asRecord(asRecord(this.interaction.response)?.answers);
    if (!answers) return "";
    return Object.entries(answers)
      .map(([question, answer]) => `${question}: ${describeAnswer(answer)}`)
      .join("\n");
  }

  mapToUiMessages(): PartialUIMessage[] {
    const messages: PartialUIMessage[] = [];
    const state = this.getLastUserMessage();
    if (state) {
      messages.push({ role: "user", parts: [{ type: "text", text: state }] });
    }
    const answers = this.getLastAssistantResponse();
    if (answers) {
      messages.push({
        role: "assistant",
        parts: [{ type: "text", text: answers }],
      });
    }
    return messages;
  }
}

export default JevDecisionsInteraction;

// === Internal helpers ===

/** `trusted (p=0.93)`, `3 (p=0.70)`, or `p(true)=0.81` for a noul answer. */
function describeAnswer(answer: unknown): string {
  const record = asRecord(answer);
  if (!record) return JSON.stringify(answer);
  if (typeof record.choice === "string") {
    return withProbability(record.choice, choiceProbability(record));
  }
  // A noul answer is the probability that the statement is true.
  if (typeof record.noul === "number") {
    return `p(true)=${record.noul.toFixed(2)}`;
  }
  if (typeof record.score === "number") {
    return withProbability(String(record.score), record.confidence);
  }
  return JSON.stringify(answer);
}

function choiceProbability(answer: Record<string, unknown>): unknown {
  const probabilities = asRecord(answer.probabilities);
  const chosen = probabilities?.[answer.choice as string];
  return typeof chosen === "number" ? chosen : answer.confidence;
}

function withProbability(label: string, probability: unknown): string {
  return typeof probability === "number"
    ? `${label} (p=${probability.toFixed(2)})`
    : label;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

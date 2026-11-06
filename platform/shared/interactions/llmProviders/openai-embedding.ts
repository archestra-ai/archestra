import type { PartialUIMessage } from "../types";
import type { Interaction, InteractionUtils } from "./common";

/**
 * An embeddings call: the text it embedded, and the vectors that came back.
 * The conversation view shows the input as the user's turn and draws each
 * vector; the numbers themselves stay in the Response view.
 */
class OpenAiEmbeddingInteraction implements InteractionUtils {
  modelName: string;
  private readonly inputs: string[];
  private readonly vectors: number[][];

  constructor(interaction: Interaction) {
    this.modelName = interaction.model ?? "unknown";
    this.inputs = inputTexts(
      (interaction.request as { input?: unknown } | null)?.input,
    );
    const data = (interaction.response as { data?: unknown } | null)?.data;
    this.vectors = Array.isArray(data)
      ? data.flatMap((item) => {
          const vector = embeddingValues(
            (item as { embedding?: unknown } | null)?.embedding,
          );
          return vector ? [vector] : [];
        })
      : [];
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

  getToolNamesRequested(): string[] {
    return [];
  }

  /** The text embedded; a batch is named by its first input. */
  getLastUserMessage(): string {
    const [first] = this.inputs;
    if (first === undefined) return "";
    const more = this.inputs.length - 1;
    return more > 0 ? `${first} (+${more} more)` : first;
  }

  /** "1 embedding, 1,536 dimensions". */
  getLastAssistantResponse(): string {
    if (this.vectors.length === 0) return "";
    const count = this.vectors.length;
    const dimensions = this.vectors[0].length;
    return `${count} ${count === 1 ? "embedding" : "embeddings"}, ${dimensions.toLocaleString("en-US")} dimensions`;
  }

  mapToUiMessages(): PartialUIMessage[] {
    if (this.inputs.length === 0 && this.vectors.length === 0) return [];
    const shown = this.inputs.slice(0, MAX_SHOWN);
    const hidden = this.inputs.length - shown.length;
    const messages: PartialUIMessage[] = [
      {
        role: "user",
        parts: [
          {
            type: "text",
            text: [
              ...shown,
              ...(hidden > 0 ? [`+${hidden} more inputs`] : []),
            ].join("\n"),
          },
        ],
      },
    ];
    if (this.vectors.length > 0) {
      messages.push({
        role: "assistant",
        parts: [
          {
            type: "data-embedding",
            data: {
              count: this.vectors.length,
              dimensions: this.vectors[0].length,
              vectors: this.vectors
                .slice(0, MAX_SHOWN)
                .map((values, index) => ({
                  label:
                    this.inputs.length > 1 ? this.inputs[index] : undefined,
                  values,
                })),
            },
          } as PartialUIMessage["parts"][number],
        ],
      });
    }
    return messages;
  }
}

export default OpenAiEmbeddingInteraction;

// ===========================================================================
// Internal helpers
// ===========================================================================

/** Inputs and vectors drawn; the rest are counted. */
const MAX_SHOWN = 5;

/** The embedded inputs as text: strings as they are, token arrays by size. */
function inputTexts(input: unknown): string[] {
  if (typeof input === "string") return [input];
  if (!Array.isArray(input) || input.length === 0) return [];
  if (input.every((item) => typeof item === "number"))
    return [`${input.length} token IDs`];
  return input.map((item) =>
    typeof item === "string"
      ? item
      : Array.isArray(item)
        ? `${item.length} token IDs`
        : "",
  );
}

/** A vector as numbers, whether logged as floats or as base64 float32. */
function embeddingValues(embedding: unknown): number[] | undefined {
  if (Array.isArray(embedding)) {
    return embedding.every((value) => typeof value === "number")
      ? (embedding as number[])
      : undefined;
  }
  if (typeof embedding !== "string" || embedding.length === 0) return;
  try {
    const binary = atob(embedding);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++)
      bytes[index] = binary.charCodeAt(index);
    return Array.from(new Float32Array(bytes.buffer, 0, bytes.length >> 2));
  } catch {
    return undefined;
  }
}

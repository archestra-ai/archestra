import type { PartialUIMessage } from "../types";
import type { Interaction, InteractionUtils } from "./common";
import {
  formatClipSeconds,
  inlineMediaPart,
  missingAudioReason,
  missingMediaPart,
  pcm16ToWav,
} from "./media";

/**
 * One response of a Realtime session: what the user said, the model's spoken
 * reply (kept up to a size limit, so it plays) and its transcript.
 */
export default class RealtimeInteraction implements InteractionUtils {
  readonly modelName: string;
  private readonly request: {
    model?: string;
    turn?: number;
    input_text?: string;
    input_transcript?: string;
  };
  private readonly response: {
    status?: string;
    output_transcript?: string;
    output_audio?: { format?: string; sample_rate?: number; data?: string };
    output_audio_omitted?: string;
    error?: unknown;
  };
  constructor(interaction: Interaction) {
    this.modelName = interaction.model ?? "unknown";
    this.request = (interaction.request ?? {}) as typeof this.request;
    this.response = (interaction.response ?? {}) as typeof this.response;
  }
  isLastMessageToolCall() {
    return false;
  }
  getLastToolCallId() {
    return null;
  }
  getToolNamesUsed() {
    return [];
  }
  getToolNamesRequested() {
    return [];
  }
  /** What the user said this turn: typed text, else the transcript of their audio. */
  getLastUserMessage() {
    const said = this.request.input_text || this.request.input_transcript;
    if (said) return said;
    const turn = this.request.turn ? ` ${this.request.turn}` : "";
    return `Realtime turn${turn}`;
  }
  getLastAssistantResponse() {
    if (this.response.error) return "Realtime response failed.";
    return (
      this.response.output_transcript ||
      `Realtime response ${this.response.status ?? "completed"} with no transcript.`
    );
  }
  mapToUiMessages(): PartialUIMessage[] {
    return [
      {
        role: "user",
        parts: [{ type: "text", text: this.getLastUserMessage() }],
      },
      {
        role: "assistant",
        parts: [
          ...this.spokenReplyParts(),
          { type: "text", text: this.getLastAssistantResponse() },
        ],
      },
    ];
  }

  private spokenReplyParts(): PartialUIMessage["parts"] {
    if (this.response.error) return [];
    const audio = this.response.output_audio;
    if (audio?.data && audio.format === "pcm16") {
      const sampleRate = audio.sample_rate ?? 24_000;
      // 16-bit mono: two bytes per sample, four base64 characters per three bytes.
      const seconds = (audio.data.length * 3) / 4 / 2 / sampleRate;
      return [
        inlineMediaPart({
          mediaType: "audio/wav",
          data: pcm16ToWav(audio.data, sampleRate),
          caption: `Spoken reply, ${formatClipSeconds(seconds)}`,
        }),
      ];
    }
    if (this.response.output_audio_omitted) {
      return [
        missingMediaPart({
          kind: "audio",
          label: "Spoken reply",
          reason: missingAudioReason(this.response.output_audio_omitted),
        }),
      ];
    }
    return [];
  }
}

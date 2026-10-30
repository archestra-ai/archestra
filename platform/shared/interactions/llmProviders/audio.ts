import type { PartialUIMessage } from "../types";
import type { Interaction, InteractionUtils } from "./common";
import {
  formatBytes,
  formatClipSeconds,
  inlineMediaPart,
  mediaFormatLabel,
  missingAudioReason,
  missingMediaPart,
  pcm16ToWav,
} from "./media";

type KeptClip = { content_type?: string; data?: string };

/**
 * Speech, transcription and translation calls. A speech row keeps the text
 * spoken and the audio returned; a transcription or translation keeps the
 * uploaded audio and the text that came back. Each clip is kept up to a size
 * limit, and the conversation view plays it.
 */
export default class AudioInteraction implements InteractionUtils {
  readonly modelName: string;
  private readonly request: {
    operation?: string;
    file?: { filename?: string; size?: number; duration_seconds?: number };
    input_characters?: number;
  };
  private readonly response: {
    bytes?: number;
    cost_available?: boolean;
    error?: unknown;
    speech_input?: string;
    transcript?: string;
    audio?: KeptClip;
    audio_omitted?: string;
    upload?: KeptClip;
    upload_omitted?: string;
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
  getLastUserMessage() {
    if (this.response.speech_input) return this.response.speech_input;
    const file = this.request.file;
    if (!file)
      return `Audio speech: ${this.request.input_characters ?? 0} input characters`;
    const kind =
      this.request.operation === "translations"
        ? "Translation"
        : "Transcription";
    const duration =
      typeof file.duration_seconds === "number"
        ? `, ${formatClipSeconds(file.duration_seconds)}`
        : "";
    return `${kind}: ${file.filename}${duration}`;
  }
  getLastAssistantResponse() {
    if (this.response.error) return "Audio request failed.";
    if (this.response.transcript) return this.response.transcript;
    if (this.response.audio?.content_type) {
      const speech = `Speech, ${mediaFormatLabel(this.response.audio.content_type)}, ${formatBytes(this.response.bytes ?? 0)}`;
      return this.response.cost_available === false
        ? `${speech}. Audio cost unavailable.`
        : speech;
    }
    const returned = `Returned ${this.response.bytes ?? 0} bytes.`;
    return this.response.cost_available === false
      ? `${returned} Audio cost unavailable.`
      : returned;
  }
  mapToUiMessages(): PartialUIMessage[] {
    return [
      { role: "user", parts: this.userParts() },
      { role: "assistant", parts: this.assistantParts() },
    ];
  }

  private userParts(): PartialUIMessage["parts"] {
    const file = this.request.file;
    if (!file) {
      return [
        {
          type: "text",
          text:
            this.response.speech_input ??
            `Text to speech, ${this.request.input_characters ?? 0} characters`,
        },
      ];
    }
    const caption = [
      file.filename,
      typeof file.duration_seconds === "number"
        ? formatClipSeconds(file.duration_seconds)
        : undefined,
    ]
      .filter(Boolean)
      .join(", ");
    const upload = this.response.upload;
    return [
      upload?.data
        ? inlineMediaPart({
            mediaType: upload.content_type ?? "audio/mpeg",
            data: upload.data,
            caption,
          })
        : missingMediaPart({
            kind: "audio",
            label: caption || "Uploaded audio",
            reason: missingAudioReason(this.response.upload_omitted),
          }),
    ];
  }

  private assistantParts(): PartialUIMessage["parts"] {
    if (this.request.file || this.response.error) {
      return [{ type: "text", text: this.getLastAssistantResponse() }];
    }
    const audio = this.response.audio;
    if (audio?.data) {
      // Raw PCM (`response_format: "pcm"`) is 24 kHz 16-bit mono; wrap it to play.
      const pcm = audio.content_type === "audio/pcm";
      const mediaType = pcm
        ? "audio/wav"
        : (audio.content_type ?? "audio/mpeg");
      return [
        inlineMediaPart({
          mediaType,
          data: pcm ? pcm16ToWav(audio.data) : audio.data,
          caption: `Speech, ${mediaFormatLabel(audio.content_type ?? mediaType)}`,
        }),
      ];
    }
    return [
      missingMediaPart({
        kind: "audio",
        label: "Speech",
        reason: missingAudioReason(this.response.audio_omitted),
      }),
    ];
  }
}

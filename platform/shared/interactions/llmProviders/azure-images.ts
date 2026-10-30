import type { PartialUIMessage } from "../types";
import type { Interaction, InteractionUtils } from "./common";
import {
  inlineMediaPart,
  linkedMediaPart,
  mediaFormatLabel,
  missingMediaPart,
} from "./media";

type ImageRequest = {
  prompt?: string;
  size?: string;
  output_format?: string;
  input_files?: {
    images?: Array<{ filename?: string; width?: number; height?: number }>;
  };
};

type ImageResponse = {
  data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
  size?: string;
  output_format?: string;
};

/**
 * Images are artifacts, not assistant text or executable tool calls: the
 * conversation view shows them inline, each with a one-line caption. An
 * edit's uploaded images are not kept, so they appear as named placeholders.
 */
export default class AzureImagesInteraction implements InteractionUtils {
  readonly modelName: string;
  private readonly request: ImageRequest;
  private readonly response: ImageResponse;
  constructor(interaction: Interaction) {
    this.modelName = interaction.model ?? "unknown";
    this.request = (interaction.request ?? {}) as ImageRequest;
    this.response = (interaction.response ?? {}) as ImageResponse;
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
    return this.request.prompt ?? "";
  }
  /** "1 image, 1024 × 1024". */
  getLastAssistantResponse() {
    const count = this.response.data?.length ?? 0;
    const size = this.size();
    return `${count} ${count === 1 ? "image" : "images"}${size ? `, ${size}` : ""}`;
  }
  mapToUiMessages(): PartialUIMessage[] {
    const inputs = (this.request.input_files?.images ?? []).map((image) =>
      missingMediaPart({
        kind: "image",
        label: [
          image.filename ?? "Input image",
          image.width && image.height
            ? `${image.width} × ${image.height}`
            : undefined,
        ]
          .filter(Boolean)
          .join(" · "),
        reason: "Uploaded images are not kept in the log",
      }),
    );
    const mediaType = `image/${(this.response.output_format ?? this.request.output_format ?? "png").toLowerCase()}`;
    const caption = [mediaFormatLabel(mediaType), this.size()]
      .filter(Boolean)
      .join(", ");
    const images: PartialUIMessage["parts"] = [];
    for (const image of this.response.data ?? []) {
      if (image.b64_json)
        images.push(
          inlineMediaPart({ mediaType, data: image.b64_json, caption }),
        );
      else if (image.url)
        images.push(linkedMediaPart({ mediaType, url: image.url, caption }));
      if (image.revised_prompt)
        images.push({
          type: "text",
          text: `Revised prompt: ${image.revised_prompt}`,
        });
    }
    if (images.length === 0)
      images.push({ type: "text", text: this.getLastAssistantResponse() });
    return [
      {
        role: "user",
        parts: [{ type: "text", text: this.request.prompt ?? "" }, ...inputs],
      },
      { role: "assistant", parts: images },
    ];
  }

  private size(): string | undefined {
    const size = this.response.size ?? this.request.size;
    return size && size !== "auto" ? size.replace("x", " × ") : undefined;
  }
}

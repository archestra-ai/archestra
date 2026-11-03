import type { PartialUIMessage } from "../types";
import type { Interaction, InteractionUtils } from "./common";
import {
  type ImageEditUploads,
  imageEditUploadParts,
  inlineMediaPart,
  linkedMediaPart,
  mediaFormatLabel,
} from "./media";

type ImageRequest = {
  prompt?: string;
  size?: string;
  output_format?: string;
  input_files?: ImageEditUploads;
};

type ImageResponse = {
  data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
  size?: string;
  output_format?: string;
};

/**
 * Images are artifacts, not assistant text or executable tool calls: the
 * conversation view shows them inline, each with a one-line caption. An
 * edit's uploaded images, and its mask, show in the user's turn; one the log
 * did not keep appears as a named placeholder saying why.
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
    const inputs = imageEditUploadParts(this.request.input_files);
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

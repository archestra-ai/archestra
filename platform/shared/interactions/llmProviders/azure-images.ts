import type { PartialUIMessage } from "../types";
import type { Interaction, InteractionUtils } from "./common";
import {
  inlineMediaPart,
  linkedMediaPart,
  mediaFormatLabel,
  missingImageReason,
  missingMediaPart,
} from "./media";

/** An edit's uploaded image: its metadata, and its bytes when the log kept them. */
type Upload = {
  filename?: string;
  mime_type?: string;
  width?: number;
  height?: number;
  data?: string;
  data_omitted?: string;
};

type ImageRequest = {
  prompt?: string;
  size?: string;
  output_format?: string;
  input_files?: { images?: Upload[]; mask?: Upload };
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
    const files = this.request.input_files;
    const inputs = [
      ...(files?.images ?? []).map((image) => uploadPart(image, "Input image")),
      ...(files?.mask ? [uploadPart(files.mask, "Mask", "Mask")] : []),
    ];
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

/** "circle.png · 1024 × 1024" shown inline, or a placeholder saying why not. */
function uploadPart(
  upload: Upload,
  fallbackName: string,
  role?: string,
): PartialUIMessage["parts"][number] {
  const caption = [
    role && upload.filename ? `${role}: ${upload.filename}` : upload.filename,
    upload.width && upload.height
      ? `${upload.width} × ${upload.height}`
      : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  return upload.data
    ? inlineMediaPart({
        mediaType: upload.mime_type ?? "image/png",
        data: upload.data,
        caption: caption || fallbackName,
      })
    : missingMediaPart({
        kind: "image",
        label: caption || fallbackName,
        reason: missingImageReason(upload.data_omitted),
      });
}

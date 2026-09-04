import type { SupportedProvider } from "@archestra/shared";
import type { ChatMessage } from "@/types";

const BASE64_MARKER = ";base64,";
const MiB = 1024 * 1024;

// Anthropic's documented request-size limits, including Amazon Bedrock's 20 MB
// cap (the direct Claude API allows 32 MB).
const REQUEST_SIZE_LIMITS_DOC_URL =
  "https://platform.claude.com/docs/en/api/overview#request-size-limits";

// Bedrock validates the base64-encoded image carried by the Converse JSON
// request against a 5 MiB ceiling. Base64 expands three input bytes into four
// wire bytes, so the largest raw image that can pass is 3.75 MiB.
const BEDROCK_IMAGE_LIMIT_BYTES = (5 * MiB * 3) / 4;

/**
 * Per-provider maximum attachment size. These are the providers' documented
 * request-size limits, applied here as an attachment-size cap so the user gets
 * a single number they recognize (their file size) instead of an opaque
 * provider error after a slow round trip.
 * @see {@link REQUEST_SIZE_LIMITS_DOC_URL}
 */
const PROVIDER_ATTACHMENT_LIMIT_BYTES: Partial<
  Record<SupportedProvider, number>
> = {
  bedrock: 20 * 1024 * 1024,
  anthropic: 32 * 1024 * 1024,
};

/**
 * The provider's documented per-request attachment ceiling, or `undefined` when
 * it publishes none. Materialization bounds its own inline budget by this so a
 * single attachment can never be the reason a request is refused — it is left
 * in the Files panel instead.
 */
export function providerAttachmentLimitBytes(
  provider: SupportedProvider,
): number | undefined {
  return PROVIDER_ATTACHMENT_LIMIT_BYTES[provider];
}

/** Maximum decoded size of one inline image for providers with such a limit. */
export function providerImageAttachmentLimitBytes(
  provider: SupportedProvider,
): number | undefined {
  return provider === "bedrock" ? BEDROCK_IMAGE_LIMIT_BYTES : undefined;
}

export class RequestTooLargeError extends Error {
  readonly provider: SupportedProvider;
  /** Decoded size of the attachment(s) — the file size the user sees. */
  readonly fileBytes: number;
  readonly limitBytes: number;
  readonly fileCount: number;

  constructor(params: {
    provider: SupportedProvider;
    fileBytes: number;
    limitBytes: number;
    fileCount: number;
  }) {
    super(formatRequestTooLargeMessage(params));
    this.name = "RequestTooLargeError";
    this.provider = params.provider;
    this.fileBytes = params.fileBytes;
    this.limitBytes = params.limitBytes;
    this.fileCount = params.fileCount;
  }
}

/**
 * Reject an attachment that is larger than the provider's size limit before the
 * request is sent, so the user gets an actionable "too large" message instead
 * of a generic provider error after a slow round trip.
 */
export function assertRequestWithinProviderPayloadLimit(params: {
  messages: ChatMessage[];
  provider: SupportedProvider;
}): void {
  const limitBytes = PROVIDER_ATTACHMENT_LIMIT_BYTES[params.provider];
  if (limitBytes === undefined) {
    return;
  }

  const { fileBytes, fileCount, attachments } = measureInlineAttachments(
    params.messages,
  );
  const imageLimitBytes = providerImageAttachmentLimitBytes(params.provider);
  if (imageLimitBytes !== undefined) {
    const oversizedImage = attachments.find(
      (attachment) =>
        attachment.mediaType.startsWith("image/") &&
        attachment.fileBytes > imageLimitBytes,
    );
    if (oversizedImage) {
      throw new RequestTooLargeError({
        provider: params.provider,
        fileBytes: oversizedImage.fileBytes,
        limitBytes: imageLimitBytes,
        fileCount: 1,
      });
    }
  }

  // Compare in whole MB — the unit shown to the user — so a file that rounds to
  // the cap is not rejected with a self-contradictory "20 MB, max 20 MB".
  if (Math.round(fileBytes / MiB) > Math.floor(limitBytes / MiB)) {
    throw new RequestTooLargeError({
      provider: params.provider,
      fileBytes,
      limitBytes,
      fileCount,
    });
  }
}

function measureInlineAttachments(messages: ChatMessage[]): {
  fileBytes: number;
  fileCount: number;
  attachments: Array<{ fileBytes: number; mediaType: string }>;
} {
  let fileBytes = 0;
  let fileCount = 0;
  const attachments: Array<{ fileBytes: number; mediaType: string }> = [];
  for (const message of messages) {
    if (!message.parts?.length) {
      continue;
    }
    for (const part of message.parts) {
      if (
        part.type !== "file" ||
        typeof part.url !== "string" ||
        !part.url.startsWith("data:")
      ) {
        continue;
      }
      const markerIndex = part.url.indexOf(BASE64_MARKER);
      if (markerIndex === -1) {
        continue;
      }
      // Attachments are carried inline as base64; the decoded file is 3/4 of
      // that length — the size the user recognizes and what the message reports.
      const payload = part.url.slice(markerIndex + BASE64_MARKER.length);
      const paddingBytes = payload.endsWith("==")
        ? 2
        : payload.endsWith("=")
          ? 1
          : 0;
      const attachmentBytes =
        Math.floor((payload.length * 3) / 4) - paddingBytes;
      const mediaType =
        typeof part.mediaType === "string" && part.mediaType.length > 0
          ? part.mediaType
          : part.url.slice(5, part.url.indexOf(";"));
      fileBytes += attachmentBytes;
      fileCount += 1;
      attachments.push({ fileBytes: attachmentBytes, mediaType });
    }
  }
  return { fileBytes, fileCount, attachments };
}

function formatRequestTooLargeMessage(params: {
  provider: SupportedProvider;
  fileBytes: number;
  limitBytes: number;
  fileCount: number;
}): string {
  const fileMB = formatMegabytes(params.fileBytes, true);
  const limitMB = formatMegabytes(params.limitBytes, false);
  const label = providerLabel(params.provider);
  const subject =
    params.fileCount > 1
      ? `Your files add up to ${fileMB} MB`
      : `This file is ${fileMB} MB`;
  const fix =
    params.fileCount > 1
      ? "Please remove some, or use smaller files."
      : "Please use a smaller file, or split it into parts.";
  return (
    `${subject}, which is too large for ${label}. ` +
    `The most you can send is ${limitMB} MB. ${fix}\n` +
    REQUEST_SIZE_LIMITS_DOC_URL
  );
}

function formatMegabytes(bytes: number, roundUp: boolean): string {
  const megabytes = bytes / MiB;
  const hundredths = roundUp
    ? Math.ceil(megabytes * 100)
    : Math.floor(megabytes * 100);
  return String(hundredths / 100);
}

function providerLabel(provider: SupportedProvider): string {
  if (provider === "bedrock") {
    return "AWS Bedrock";
  }
  if (provider === "anthropic") {
    return "Anthropic";
  }
  return provider;
}

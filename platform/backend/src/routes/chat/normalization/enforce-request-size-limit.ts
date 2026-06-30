import type { SupportedProvider } from "@archestra/shared";
import type { ChatMessage } from "@/types";

// Anthropic's documented request-size limits, including Amazon Bedrock's 20 MB
// cap (the direct Claude API allows 32 MB).
const REQUEST_SIZE_LIMITS_DOC_URL =
  "https://platform.claude.com/docs/en/api/overview#request-size-limits";

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

const BASE64_MARKER = ";base64,";

const MiB = 1024 * 1024;

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

  const { fileBytes, fileCount } = measureInlineAttachments(params.messages);
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
} {
  let fileBytes = 0;
  let fileCount = 0;
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
      const base64Length =
        part.url.length - (markerIndex + BASE64_MARKER.length);
      fileBytes += Math.floor((base64Length * 3) / 4);
      fileCount += 1;
    }
  }
  return { fileBytes, fileCount };
}

function formatRequestTooLargeMessage(params: {
  provider: SupportedProvider;
  fileBytes: number;
  limitBytes: number;
  fileCount: number;
}): string {
  const fileMB = Math.round(params.fileBytes / MiB);
  const limitMB = Math.floor(params.limitBytes / MiB);
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

function providerLabel(provider: SupportedProvider): string {
  if (provider === "bedrock") {
    return "AWS Bedrock";
  }
  if (provider === "anthropic") {
    return "Anthropic";
  }
  return provider;
}

import type { SupportedProvider } from "@archestra/shared";
import type { ChatMessage } from "@/types";

/**
 * Anthropic's documented request-size cap for Claude (PDFs and other documents
 * included) is 32 MB, measured decimally: a Bedrock request just over
 * 32,000,000 bytes is rejected with "Input is too long for requested model".
 * On this path the document is base64-inlined into the request (Bedrock's
 * out-of-band `s3Location` source isn't used yet), and base64 inflates the file
 * ~33%, so a large attachment fills this budget and trips the cap before the
 * model reads it.
 * @see https://platform.claude.com/docs/en/docs/build-with-claude/pdf-support
 */
const CLAUDE_REQUEST_PAYLOAD_LIMIT_BYTES = 32_000_000;

// Only providers whose request-size limit we know are guarded; everything else
// is left to the provider so we never block a request a provider would accept.
const PROVIDER_REQUEST_PAYLOAD_LIMIT_BYTES: Partial<
  Record<SupportedProvider, number>
> = {
  bedrock: CLAUDE_REQUEST_PAYLOAD_LIMIT_BYTES,
  anthropic: CLAUDE_REQUEST_PAYLOAD_LIMIT_BYTES,
};

const BASE64_MARKER = ";base64,";

export class RequestTooLargeError extends Error {
  readonly provider: SupportedProvider;
  /** Decoded size of the attachment(s), i.e. the file size the user sees. */
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
 * Fail fast when inline attachments push the request past the provider's known
 * request-size limit, so the user gets an actionable "too large" message
 * instead of a generic provider error after a slow round trip. Compares the
 * base64 (wire) size against the limit — the dominant term in an over-limit
 * request — so it is a conservative lower bound: it never false-blocks, but a
 * near-limit request whose non-file content tips it over can still reach the
 * provider.
 */
export function assertRequestWithinProviderPayloadLimit(params: {
  messages: ChatMessage[];
  provider: SupportedProvider;
}): void {
  const limitBytes = PROVIDER_REQUEST_PAYLOAD_LIMIT_BYTES[params.provider];
  if (limitBytes === undefined) {
    return;
  }

  const { encodedBytes, fileBytes, fileCount } = measureInlineAttachments(
    params.messages,
  );
  if (encodedBytes > limitBytes) {
    throw new RequestTooLargeError({
      provider: params.provider,
      fileBytes,
      limitBytes,
      fileCount,
    });
  }
}

function measureInlineAttachments(messages: ChatMessage[]): {
  encodedBytes: number;
  fileBytes: number;
  fileCount: number;
} {
  let encodedBytes = 0;
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
      // The base64 text is what travels on the wire (~1 byte per char, the unit
      // the provider's size cap counts); the decoded file is 3/4 of that — the
      // size the user recognizes and what the message reports.
      const base64Length =
        part.url.length - (markerIndex + BASE64_MARKER.length);
      encodedBytes += base64Length;
      fileBytes += Math.floor((base64Length * 3) / 4);
      fileCount += 1;
    }
  }
  return { encodedBytes, fileBytes, fileCount };
}

function formatRequestTooLargeMessage(params: {
  provider: SupportedProvider;
  fileBytes: number;
  limitBytes: number;
  fileCount: number;
}): string {
  const MiB = 1024 * 1024;
  const fileMB = Math.round(params.fileBytes / MiB);
  // The largest raw attachment that still fits once base64 inflates it (~×4/3).
  // Floored so it always reads below the (rounded) file size — no "23 over 24".
  const maxAttachmentMB = Math.floor((params.limitBytes * 3) / 4 / MiB);
  const label = providerLabel(params.provider);
  const subject =
    params.fileCount > 1
      ? `Your attachments total ${fileMB} MB`
      : `This file is ${fileMB} MB`;
  const recovery =
    params.fileCount > 1
      ? "Compress or split large files, or remove some, and try again."
      : "Compress or split it, or attach a smaller one, and try again.";
  return (
    `${subject}, over the ~${maxAttachmentMB} MB limit for ${label}. ` +
    `Attachments are sent to the model inline (base64), which inflates them ~33%. ` +
    recovery
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

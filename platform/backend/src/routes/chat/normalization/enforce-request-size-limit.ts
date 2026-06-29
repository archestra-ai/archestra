import type { SupportedProvider } from "@archestra/shared";
import type { ChatMessage } from "@/types";

/**
 * Claude rejects any request whose whole payload exceeds 32 MB, and on Amazon
 * Bedrock only base64-inline document sources are available — there is no
 * out-of-band file reference to keep the payload small. So a large attachment
 * is sent inline and trips the limit before the model ever reads it, surfacing
 * as a generic "Input is too long for requested model" provider error.
 * @see https://platform.claude.com/docs/en/docs/build-with-claude/pdf-support
 */
const CLAUDE_REQUEST_PAYLOAD_LIMIT_BYTES = 32 * 1024 * 1024;

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
  readonly payloadBytes: number;
  readonly limitBytes: number;

  constructor(params: {
    provider: SupportedProvider;
    payloadBytes: number;
    limitBytes: number;
  }) {
    super(formatRequestTooLargeMessage(params));
    this.name = "RequestTooLargeError";
    this.provider = params.provider;
    this.payloadBytes = params.payloadBytes;
    this.limitBytes = params.limitBytes;
  }
}

/**
 * Fail fast when inline attachments push the request past the provider's known
 * request-size limit, so the user gets an actionable "too large" message
 * instead of a generic provider error after a slow round trip. Counts only the
 * inline attachment payload — the dominant term in an over-limit request — so it
 * is a conservative lower bound: it never false-blocks, but a near-limit request
 * whose non-file content tips it over can still reach the provider.
 */
export function assertRequestWithinProviderPayloadLimit(params: {
  messages: ChatMessage[];
  provider: SupportedProvider;
}): void {
  const limitBytes = PROVIDER_REQUEST_PAYLOAD_LIMIT_BYTES[params.provider];
  if (limitBytes === undefined) {
    return;
  }

  const payloadBytes = measureInlineFilePayloadBytes(params.messages);
  if (payloadBytes > limitBytes) {
    throw new RequestTooLargeError({
      provider: params.provider,
      payloadBytes,
      limitBytes,
    });
  }
}

function measureInlineFilePayloadBytes(messages: ChatMessage[]): number {
  let total = 0;
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
      if (markerIndex !== -1) {
        // The base64 text is what travels on the wire; its length in chars is
        // ~1 byte each, a close proxy for the bytes the provider counts.
        total += part.url.length - (markerIndex + BASE64_MARKER.length);
      }
    }
  }
  return total;
}

function formatRequestTooLargeMessage(params: {
  provider: SupportedProvider;
  payloadBytes: number;
  limitBytes: number;
}): string {
  const MB = 1024 * 1024;
  // Round the payload up and the limit down so the two figures can never round
  // to the same number and read as a self-contradictory "~32 MB exceeds 32 MB".
  const payloadMB = Math.ceil(params.payloadBytes / MB);
  const limitMB = Math.floor(params.limitBytes / MB);
  return (
    `This request is ~${payloadMB} MB, which exceeds the ` +
    `${limitMB} MB size limit for ${providerLabel(params.provider)}. ` +
    `Compress or split large attachments — or remove some — and try again.`
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

import type { ConverseStreamOutput } from "@aws-sdk/client-bedrock-runtime";
import { EventStreamCodec } from "@smithy/eventstream-codec";
import { fromUtf8, toUtf8 } from "@smithy/util-utf8";
import { AwsV4Signer } from "aws4fetch";
import logger from "@/logging";
import type { Bedrock } from "@/types";

// =============================================================================
// TYPES
// =============================================================================

type ConverseResponse = Bedrock.Types.ConverseResponse;

interface BedrockClientConfig {
  baseUrl: string;
  region: string;
  /** Bearer token for API key auth (takes precedence over AWS credentials) */
  apiKey?: string;
  /** AWS access key ID for SigV4 auth */
  accessKeyId?: string;
  /** AWS secret access key for SigV4 auth */
  secretAccessKey?: string;
  /** AWS session token for SigV4 auth (optional) */
  sessionToken?: string;
}

// Use SDK stream event type with raw bytes for passthrough
type BedrockStreamEventWithRaw = ConverseStreamOutput & {
  __rawBytes?: Uint8Array;
};

// Padding alphabet used by Bedrock (lowercase + uppercase + digits)
const PADDING_ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

// Event stream codec for binary encoding/decoding
const eventStreamCodec = new EventStreamCodec(toUtf8, fromUtf8);

// =============================================================================
// BEDROCK CLIENT
// =============================================================================

/**
 * Fetch-based Bedrock client supporting Bearer token auth and SigV4 auth.
 * Based on @ai-sdk/amazon-bedrock implementation patterns.
 */
export class BedrockClient {
  private config: BedrockClientConfig;

  constructor(config: BedrockClientConfig) {
    this.config = config;
    logger.info(
      {
        hasApiKey: !!config.apiKey,
        hasAccessKeyId: !!config.accessKeyId,
        region: config.region,
        baseUrl: config.baseUrl,
      },
      "[BedrockClient] initialized",
    );
  }

  /**
   * Non-streaming converse request
   */
  async converse(
    modelId: string,
    request: Record<string, unknown>,
  ): Promise<ConverseResponse> {
    const url = this.buildUrl(modelId, "converse");
    const body = JSON.stringify(request);

    const toolConfig = request.toolConfig as { tools?: unknown[] } | undefined;
    logger.debug(
      { modelId, url, hasTools: !!toolConfig?.tools?.length },
      "[BedrockClient] converse request",
    );

    const response = await this.signedFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error(
        { status: response.status, errorBody },
        "[BedrockClient] converse error",
      );
      const error = new Error(
        errorBody || `Bedrock API error: ${response.status}`,
      );
      (error as Error & { statusCode: number }).statusCode = response.status;
      (error as Error & { responseBody: string }).responseBody = errorBody;
      throw error;
    }

    const result = await response.json();
    logger.info({ response: result }, "[BedrockClient] converse response");
    return result as ConverseResponse;
  }

  /**
   * Streaming converse request
   * Returns an async iterable of stream events with raw bytes for passthrough
   */
  async converseStream(
    modelId: string,
    request: Record<string, unknown>,
  ): Promise<AsyncIterable<BedrockStreamEventWithRaw>> {
    const url = this.buildUrl(modelId, "converse-stream");
    const body = JSON.stringify(request);

    const toolConfig = request.toolConfig as { tools?: unknown[] } | undefined;
    logger.debug(
      { modelId, url, hasTools: !!toolConfig?.tools?.length },
      "[BedrockClient] converseStream request",
    );

    const response = await this.signedFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error(
        { status: response.status, errorBody },
        "[BedrockClient] converseStream error",
      );
      const error = new Error(
        errorBody || `Bedrock API error: ${response.status}`,
      );
      (error as Error & { statusCode: number }).statusCode = response.status;
      (error as Error & { responseBody: string }).responseBody = errorBody;
      throw error;
    }

    if (!response.body) {
      throw new Error("Bedrock API returned no stream body");
    }

    return this.createEventStreamIterable(response.body);
  }

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

  private buildUrl(modelId: string, endpoint: "converse" | "converse-stream") {
    const encodedModelId = encodeURIComponent(modelId);
    return `${this.config.baseUrl}/model/${encodedModelId}/${endpoint}`;
  }

  /**
   * Perform a signed fetch request.
   * Uses Bearer token auth if apiKey is provided, otherwise SigV4.
   */
  private async signedFetch(url: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);

    if (this.config.apiKey) {
      // Bearer token auth
      headers.set("Authorization", `Bearer ${this.config.apiKey}`);
      logger.debug("[BedrockClient] using Bearer token auth");
    } else if (this.config.accessKeyId && this.config.secretAccessKey) {
      // SigV4 auth using aws4fetch
      logger.debug("[BedrockClient] using SigV4 auth");

      const bodyString =
        typeof init.body === "string"
          ? init.body
          : init.body instanceof Uint8Array
            ? new TextDecoder().decode(init.body)
            : JSON.stringify(init.body);

      const signer = new AwsV4Signer({
        url,
        method: init.method ?? "POST",
        headers: Array.from(headers.entries()),
        body: bodyString,
        region: this.config.region,
        accessKeyId: this.config.accessKeyId,
        secretAccessKey: this.config.secretAccessKey,
        sessionToken: this.config.sessionToken,
        service: "bedrock",
      });

      const signingResult = await signer.sign();

      // Add signed headers to request
      for (const [key, value] of signingResult.headers.entries()) {
        headers.set(key, value);
      }
    } else {
      logger.warn("[BedrockClient] no authentication configured");
    }

    return fetch(url, {
      ...init,
      headers,
    });
  }

  /**
   * Create an async iterable from a readable stream of event stream bytes
   */
  private createEventStreamIterable(
    body: ReadableStream<Uint8Array>,
  ): AsyncIterable<BedrockStreamEventWithRaw> {
    const textDecoder = new TextDecoder();

    return {
      [Symbol.asyncIterator]: async function* () {
        const reader = body.getReader();
        let buffer = new Uint8Array(0);

        try {
          while (true) {
            const { done, value } = await reader.read();

            if (done) {
              break;
            }

            // Append new data to buffer
            const newBuffer = new Uint8Array(buffer.length + value.length);
            newBuffer.set(buffer);
            newBuffer.set(value, buffer.length);
            buffer = newBuffer;

            // Process complete messages from buffer
            while (buffer.length >= 4) {
              // Read total message length (first 4 bytes, big-endian)
              const totalLength = new DataView(
                buffer.buffer,
                buffer.byteOffset,
                buffer.byteLength,
              ).getUint32(0, false);

              if (buffer.length < totalLength) {
                // Not enough data yet
                break;
              }

              try {
                // Extract and decode the message
                const messageBytes = buffer.subarray(0, totalLength);
                const decoded = eventStreamCodec.decode(messageBytes);
                buffer = buffer.slice(totalLength);

                // Parse event
                const eventTypeValue = decoded.headers[":event-type"]?.value;
                const messageTypeValue =
                  decoded.headers[":message-type"]?.value;

                // Event type and message type are strings from the event stream
                const eventType =
                  typeof eventTypeValue === "string" ? eventTypeValue : null;
                const messageType =
                  typeof messageTypeValue === "string"
                    ? messageTypeValue
                    : null;

                if (messageType === "event" && eventType) {
                  const data = textDecoder.decode(decoded.body);
                  const parsedData = JSON.parse(data);

                  // Remove padding field if present
                  delete parsedData.p;

                  // Wrap in event type key and add raw bytes
                  const event = {
                    [eventType]: parsedData,
                    __rawBytes: encodeEventStreamMessage(eventType, parsedData),
                  } as BedrockStreamEventWithRaw;

                  yield event;
                }
              } catch (e) {
                logger.warn(
                  { error: e },
                  "[BedrockClient] failed to decode event stream message",
                );
                break;
              }
            }
          }
        } finally {
          reader.releaseLock();
        }
      },
    };
  }
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Generate padding string to match Bedrock's format.
 */
function generatePadding(currentBodyLength: number, targetSize = 80): string {
  const paddingNeeded = Math.max(0, targetSize - currentBodyLength - 10);
  return PADDING_ALPHABET.slice(
    0,
    Math.min(paddingNeeded, PADDING_ALPHABET.length),
  );
}

/**
 * Encode an event to AWS Event Stream binary format.
 * Adds padding field "p" to match Bedrock's format.
 */
function encodeEventStreamMessage(
  eventType: string,
  body: unknown,
): Uint8Array {
  const bodyWithoutPadding = JSON.stringify(body);
  const padding = generatePadding(bodyWithoutPadding.length);
  const bodyWithPadding = { ...(body as Record<string, unknown>), p: padding };
  const bodyJson = JSON.stringify(bodyWithPadding);
  const bodyBytes = fromUtf8(bodyJson);

  return eventStreamCodec.encode({
    headers: {
      ":event-type": { type: "string", value: eventType },
      ":content-type": { type: "string", value: "application/json" },
      ":message-type": { type: "string", value: "event" },
    },
    body: bodyBytes,
  });
}

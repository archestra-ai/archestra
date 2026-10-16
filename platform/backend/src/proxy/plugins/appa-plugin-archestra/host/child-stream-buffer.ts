import { ApiError, type LLMStreamAdapter } from "@/types";
import { asRecord } from "@/utils/as-record";

type StreamEvent = string | Uint8Array;

/**
 * Holds a governed child's stream until the plugins release it: model events
 * first, then policy events. When disabled, every event goes straight to the
 * client.
 */
export class BufferedChildStream {
  private readonly enabled: boolean;
  private readonly write: (data: StreamEvent) => void;
  private bufferedBytes = 0;
  private readonly modelEvents: StreamEvent[] = [];
  private readonly policyEvents: StreamEvent[] = [];

  constructor(params: {
    enabled: boolean;
    write: (data: StreamEvent) => void;
  }) {
    this.enabled = params.enabled;
    this.write = params.write;
  }

  emitModel(data: StreamEvent, isResponsePreamble = false): void {
    if (
      this.enabled &&
      !(isResponsePreamble && !preambleSseCarriesContent(data))
    ) {
      this.count(data);
      this.modelEvents.push(data);
      return;
    }
    this.write(data);
  }

  emitPolicy(data: StreamEvent): void {
    if (this.enabled) {
      this.count(data);
      this.policyEvents.push(data);
      return;
    }
    this.write(data);
  }

  discard(
    adapter: Pick<
      LLMStreamAdapter<unknown, unknown>,
      "prepareResponseReplacement"
    >,
  ): void {
    if (!this.enabled) return;
    adapter.prepareResponseReplacement?.();
    this.modelEvents.length = 0;
    this.policyEvents.length = 0;
  }

  /** Replacement text is the plugin's own, so it does not count toward the cap. */
  replaceResponse(events: StreamEvent[]): void {
    this.policyEvents.push(...events);
  }

  flushModel(): void {
    for (const event of this.modelEvents) this.write(event);
  }

  flushAll(): void {
    this.flushModel();
    for (const event of this.policyEvents) this.write(event);
  }

  private count(data: StreamEvent): void {
    this.bufferedBytes +=
      typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
    if (this.bufferedBytes > MAX_BUFFERED_CHILD_STREAM_BYTES) {
      throw new ApiError(
        413,
        "OpenAPPA child stream exceeded response buffer limit",
      );
    }
  }
}

const MAX_BUFFERED_CHILD_STREAM_BYTES = 10 * 1024 * 1024;

// Verifies that preamble frames carry no content before release without buffering.
// Envelopes like message_start or response.created can contain text.
// Any frame that cannot be proven content-free is treated as content.
function preambleSseCarriesContent(data: StreamEvent): boolean {
  const text =
    typeof data === "string" ? data : Buffer.from(data).toString("utf8");
  let sawDataLine = false;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    sawDataLine = true;
    let frame: unknown;
    try {
      frame = JSON.parse(line.slice("data:".length).trim());
    } catch {
      return true;
    }
    const payload = asRecord(frame);
    if (!payload) return true;
    // Anthropic envelope: message_start carries the initial Message object.
    if (payload.type === "message_start") {
      const content = asRecord(payload.message)?.content;
      if (Array.isArray(content) && content.length > 0) return true;
      continue;
    }
    // OpenAI/Azure Responses envelope: response.created and
    // response.in_progress carry the in-flight Response object.
    if (
      typeof payload.type === "string" &&
      payload.type.startsWith("response.")
    ) {
      const output = asRecord(payload.response)?.output;
      if (Array.isArray(output) && output.length > 0) return true;
      continue;
    }
    // OpenAI chat chunk: only a role-only delta is content-free.
    if (Array.isArray(payload.choices)) {
      for (const choice of payload.choices) {
        const delta = asRecord(asRecord(choice)?.delta);
        if (
          delta?.content ||
          delta?.reasoning_content ||
          delta?.refusal ||
          delta?.tool_calls
        ) {
          return true;
        }
      }
      continue;
    }
    return true;
  }
  return !sawDataLine;
}

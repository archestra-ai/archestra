import { APIError } from "openai";

/**
 * Opens a chat-completions stream and yields its parsed chunks.
 *
 * The SDK's stream parser sends every upstream read through three async
 * generators and a byte-copying line decoder. This reader parses the same
 * server-sent events in one generator, which takes about a tenth off the
 * proxy's CPU per stream. It fails the way the SDK does: a chunk carrying an
 * `error` object throws an `APIError`, an unparseable chunk throws, and an
 * aborted request ends the stream quietly.
 *
 * A client that is not the OpenAI SDK, such as a wrapper that answers
 * `chat.completions.create` itself, already returns chunks; those pass through.
 */
export async function streamChatCompletionChunks<T>(
  request: PromiseLike<unknown>,
  onAccepted?: () => void,
): Promise<AsyncIterable<T>> {
  if (isSdkRequest(request)) {
    const response = await request.asResponse();
    onAccepted?.();
    return readChunks<T>(response);
  }
  return (await request) as AsyncIterable<T>;
}

// ===========================================================================
// Internal
// ===========================================================================

function isSdkRequest(
  request: PromiseLike<unknown>,
): request is PromiseLike<unknown> & { asResponse(): Promise<Response> } {
  return typeof (request as { asResponse?: unknown }).asResponse === "function";
}

async function* readChunks<T>(response: Response): AsyncGenerator<T> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = new SseDataReader();
  // Like the SDK, read to the end after [DONE] so the connection is reusable.
  let done = false;
  try {
    for (;;) {
      const { value, done: ended } = await reader.read();
      const text = ended
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      for (const data of events.push(text, ended)) {
        if (done) continue;
        if (data.startsWith("[DONE]")) {
          done = true;
          continue;
        }
        const chunk = JSON.parse(data);
        if (chunk?.error) {
          throw new APIError(
            undefined,
            chunk.error,
            undefined,
            response.headers,
          );
        }
        yield chunk as T;
      }
      if (ended) return;
    }
  } catch (error) {
    if (isAbortError(error)) return;
    throw error;
  } finally {
    // Releases the upstream when the consumer stops reading early.
    reader.cancel().catch(() => {});
  }
}

/** Collects the `data` of each complete server-sent event. */
class SseDataReader {
  private pending = "";
  private data: string[] = [];

  push(text: string, final: boolean): string[] {
    const buffer = this.pending + text;
    const events: string[] = [];
    const hasCarriageReturn = buffer.includes("\r");
    let start = 0;
    while (start < buffer.length) {
      let end = buffer.indexOf("\n", start);
      let next = end + 1;
      if (hasCarriageReturn) {
        const carriageReturn = buffer.indexOf("\r", start);
        if (carriageReturn !== -1 && (end === -1 || carriageReturn < end)) {
          // A trailing "\r" may be the first half of a "\r\n".
          if (carriageReturn === buffer.length - 1 && !final) break;
          end = carriageReturn;
          next =
            buffer[carriageReturn + 1] === "\n"
              ? carriageReturn + 2
              : carriageReturn + 1;
        }
      }
      if (end === -1) break;
      this.line(buffer.slice(start, end), events);
      start = next;
    }
    this.pending = buffer.slice(start);
    return events;
  }

  private line(line: string, events: string[]): void {
    if (line === "") {
      if (this.data.length > 0) events.push(this.data.join("\n"));
      this.data = [];
      return;
    }
    // Comments and the event, id, and retry fields carry nothing a chunk needs.
    if (line === "data") this.data.push("");
    else if (line.startsWith("data:")) {
      this.data.push(line.slice(line.charCodeAt(5) === 32 ? 6 : 5));
    }
  }
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

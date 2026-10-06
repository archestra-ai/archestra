/** Bound the exact command/history parts before native admission, keeping the current turn. */
export function boundedEmailContext(params: {
  body: string;
  history: string;
  maxBytes: number;
}): { body: string; history: string; message: string } {
  const prefix = "[Current message from user]: ";
  const combined = params.history
    ? `${params.history}${prefix}${params.body}`
    : params.body;
  if (Buffer.byteLength(combined, "utf8") <= params.maxBytes)
    return { body: params.body, history: params.history, message: combined };
  const notice = `\n\n[Message truncated - original size exceeded ${params.maxBytes / 1024}KB limit]`;
  const framing = params.history ? Buffer.byteLength(prefix, "utf8") : 0;
  const available =
    params.maxBytes - Buffer.byteLength(notice, "utf8") - framing;
  if (available < 0)
    throw new Error("Email context bound is too small for its framing");
  const body = utf8Prefix(params.body, available);
  const history = utf8Prefix(
    params.history,
    available - Buffer.byteLength(body, "utf8"),
  );
  const boundedBody = `${body}${notice}`;
  return {
    body: boundedBody,
    history,
    message: history ? `${history}${prefix}${boundedBody}` : boundedBody,
  };
}

function utf8Prefix(text: string, bytes: number): string {
  // Streaming decode leaves an incomplete final code point out, rather than
  // adding a replacement character that can itself exceed the byte budget.
  return new TextDecoder("utf8").decode(
    Buffer.from(text, "utf8").subarray(0, Math.max(0, bytes)),
    { stream: true },
  );
}

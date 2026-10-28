import { EventStreamCodec } from "@smithy/eventstream-codec";
import { fromUtf8, toUtf8 } from "@smithy/util-utf8";
import { HttpResponse } from "msw";

/** Provider wire fixtures only; routes, adapters, SDKs and billing stay real. */
export function promptCacheUpstreamResponse(options: {
  provider: "anthropic" | "openai" | "azure" | "bedrock" | "gemini";
  api: string;
  model: string;
  stream: boolean;
  reads: number;
  writes: number;
  oneHourWrites?: number;
}): Response {
  const {
    provider,
    api,
    model,
    stream,
    reads,
    writes,
    oneHourWrites = 0,
  } = options;
  const promptTokens = 10 + reads + writes;
  const usage = {
    prompt_tokens: promptTokens,
    completion_tokens: 5,
    total_tokens: promptTokens + 5,
    prompt_tokens_details: { cached_tokens: reads, cache_write_tokens: writes },
  };
  if (provider === "bedrock") {
    const usage = {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: promptTokens + 5,
      cacheReadInputTokens: reads,
      cacheWriteInputTokens: writes,
      ...(oneHourWrites > 0
        ? {
            cacheDetails: [
              { ttl: "1h", inputTokens: oneHourWrites },
              { ttl: "5m", inputTokens: writes - oneHourWrites },
            ],
          }
        : {}),
    };
    if (!stream)
      return HttpResponse.json({
        output: {
          message: {
            role: "assistant",
            content: [{ text: "answer" }],
          },
        },
        stopReason: "end_turn",
        usage,
      });
    const codec = new EventStreamCodec(toUtf8, fromUtf8);
    const events: Array<[string, unknown]> = [
      ["messageStart", { role: "assistant" }],
      [
        "contentBlockDelta",
        { contentBlockIndex: 0, delta: { text: "answer" } },
      ],
      ["contentBlockStop", { contentBlockIndex: 0 }],
      ["messageStop", { stopReason: "end_turn" }],
      ["metadata", { usage }],
    ];
    const parts = events.map(([type, body]) =>
      codec.encode({
        headers: {
          ":event-type": { type: "string", value: type },
          ":content-type": {
            type: "string",
            value: "application/json",
          },
          ":message-type": { type: "string", value: "event" },
        },
        body: fromUtf8(JSON.stringify(body)),
      }),
    );
    const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    return new HttpResponse(bytes, {
      headers: {
        "content-type": "application/vnd.amazon.eventstream",
      },
    });
  }
  if (provider === "anthropic") {
    const usage = {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: reads,
      cache_creation_input_tokens: writes,
      ...(oneHourWrites > 0
        ? {
            cache_creation: {
              ephemeral_1h_input_tokens: oneHourWrites,
              ephemeral_5m_input_tokens: writes - oneHourWrites,
            },
          }
        : {}),
    };
    const message = {
      id: "msg_cache",
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text: "answer" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage,
    };
    if (!stream) return HttpResponse.json(message);
    const events = [
      {
        type: "message_start",
        message: {
          ...message,
          content: [],
          stop_reason: null,
          usage: { ...usage, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "answer" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 5 },
      },
      { type: "message_stop" },
    ];
    return new HttpResponse(
      events
        .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
        .join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  }
  if (provider === "gemini") {
    const message = {
      candidates: [
        {
          content: { role: "model", parts: [{ text: "answer" }] },
          finishReason: "STOP",
          index: 0,
        },
      ],
      usageMetadata: {
        promptTokenCount: promptTokens,
        candidatesTokenCount: 5,
        totalTokenCount: promptTokens + 5,
        cachedContentTokenCount: reads,
      },
      modelVersion: model,
    };
    return !stream
      ? HttpResponse.json(message)
      : new HttpResponse(`data: ${JSON.stringify(message)}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
  }
  if (api === "responses") {
    const response = {
      id: "resp_cache",
      object: "response",
      created_at: 1,
      status: "completed",
      model,
      output: [
        {
          id: "msg_cache",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: "answer",
              annotations: [],
            },
          ],
        },
      ],
      usage: {
        input_tokens: promptTokens,
        output_tokens: 5,
        total_tokens: promptTokens + 5,
        input_tokens_details: {
          cached_tokens: reads,
          cache_write_tokens: writes,
        },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    };
    if (!stream) return HttpResponse.json(response);
    return new HttpResponse(
      `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", sequence_number: 0, response })}\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
  }
  const message = {
    id: "chatcmpl_cache",
    object: "chat.completion",
    created: 1,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "answer" },
        finish_reason: "stop",
      },
    ],
    usage,
  };
  if (!stream) return HttpResponse.json(message);
  const chunks = [
    {
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "answer" },
          finish_reason: "stop",
        },
      ],
    },
    { choices: [], usage },
  ];
  return new HttpResponse(
    `${chunks
      .map(
        (c) =>
          `data: ${JSON.stringify({ ...message, object: "chat.completion.chunk", ...c })}\n\n`,
      )
      .join("")}data: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

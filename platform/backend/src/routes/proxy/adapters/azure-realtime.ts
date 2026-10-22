import { randomUUID } from "node:crypto";
import { getAzureModelKind } from "@archestra/shared";
import { WebSocket } from "ws";
import type { z } from "zod";
import {
  getAzureOpenAiBearerTokenProvider,
  isAzureOpenAiEntraIdEnabled,
} from "@/clients/azure-openai-credentials";
import {
  isAzureOpenAiV1BaseUrl,
  normalizeAzureApiKey,
} from "@/clients/azure-url";
import { realtimePcmToWav, wavToRealtimePcm } from "@/clients/realtime-audio";
import config from "@/config";
import type { CreateClientOptions, LLMProvider } from "@/types";
import { ApiError, type Azure } from "@/types";
import { azureAdapterFactory } from "./azure";

type TurnRequest = z.infer<typeof Azure.API.RealtimeTurnRequestSchema>;
type TurnResponse = Azure.Types.ChatCompletionsResponse;
type TurnMessages = TurnRequest["messages"];
type Client = { apiKey?: string; options: CreateClientOptions };

/** Bounded audio turns use native Realtime WebSockets upstream, with proxy governance. */
export const azureRealtimeAdapterFactory: LLMProvider<
  TurnRequest,
  TurnResponse,
  TurnMessages,
  Azure.Types.ChatCompletionChunk,
  Azure.Types.ChatCompletionsHeaders
> = {
  ...azureAdapterFactory,
  interactionType: "azure:realtime",
  recordRequestDurationInHandler: true,
  createClient: (apiKey, options): Client => ({ apiKey, options }),
  async execute(client, request) {
    return runTurn(client as Client, request);
  },
  async executeStream(client, request) {
    const response = await runTurn(client as Client, request);
    const message = response.choices[0]?.message;
    return (async function* () {
      // Speech is emitted as one completed file; text and audio share the same turn.
      yield {
        id: response.id,
        object: "chat.completion.chunk",
        created: response.created,
        model: response.model,
        choices: [
          {
            index: 0,
            finish_reason: null,
            delta: {
              role: "assistant",
              content: message?.content,
              ...(message?.audio ? { audio: message.audio } : {}),
            },
          },
        ],
      } as Azure.Types.ChatCompletionChunk;
      yield {
        id: response.id,
        object: "chat.completion.chunk",
        created: response.created,
        model: response.model,
        choices: [{ index: 0, finish_reason: "stop", delta: {} }],
        usage: response.usage,
      } as Azure.Types.ChatCompletionChunk;
    })();
  },
};

async function runTurn(
  client: Client,
  request: TurnRequest,
): Promise<TurnResponse> {
  const kind = getAzureModelKind(request.model);
  if (kind !== "realtime" && kind !== "translation")
    throw new ApiError(
      400,
      "Select a realtime or realtime translation deployment for this endpoint.",
    );
  if (
    request.tools?.length ||
    request.messages.some(
      (message) =>
        message.role === "tool" ||
        (message.role === "assistant" && message.tool_calls?.length),
    )
  )
    throw new ApiError(400, "Realtime media turns do not execute agent tools.");
  const baseUrl = client.options.baseUrl ?? config.llm.azure.baseUrl;
  if (!baseUrl)
    throw new ApiError(400, "Azure AI Foundry base URL is required.");
  const translation = kind === "translation";
  const v1 = isAzureOpenAiV1BaseUrl(baseUrl);
  if (!v1)
    throw new ApiError(
      400,
      "Realtime audio turns require an Azure /openai/v1 endpoint.",
    );
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/realtime${translation ? "/translations" : ""}`;
  url.search = "";
  url.searchParams.set("model", request.model);
  const key = normalizeAzureApiKey(client.apiKey);
  if (!key && !isAzureOpenAiEntraIdEnabled())
    throw new ApiError(
      401,
      "Azure API key or Entra ID authentication is required.",
    );
  const headers = {
    ...client.options.defaultHeaders,
    ...(key
      ? { "api-key": key }
      : {
          authorization: `Bearer ${await getAzureOpenAiBearerTokenProvider(baseUrl)()}`,
        }),
  };
  const instructions = request.messages
    .filter(
      (message) => message.role === "system" || message.role === "developer",
    )
    .map((message) =>
      typeof message.content === "string" ? message.content : "",
    )
    .join("\n");
  const items = request.messages.filter(
    (message) => message.role === "user" || message.role === "assistant",
  );
  const latest = items.findLast((message) => message.role === "user");
  const audioParts =
    latest && Array.isArray(latest.content)
      ? latest.content.filter((part) => part.type === "input_audio")
      : [];
  if (translation && (!request.target_language || audioParts.length === 0))
    throw new ApiError(
      400,
      "Translation requires an uploaded WAV file and a target_language such as es.",
    );
  const inputPcm = translation
    ? Buffer.concat(
        audioParts.map((part) => decodeAudio(part.input_audio.data)),
      )
    : undefined;
  const signal = client.options.abortSignal;
  signal?.throwIfAborted();

  return new Promise<TurnResponse>((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers,
      handshakeTimeout: 15000,
      maxPayload: 16 * 1024 * 1024,
    });
    const audio: Buffer[] = [];
    let audioBytes = 0;
    let text = "",
      finished = false,
      started = false;
    let usage: TurnResponse["usage"];
    const timer = setTimeout(
      () => finish(new ApiError(504, "Azure realtime turn timed out.")),
      90000,
    );
    const abort = () =>
      finish(signal?.reason ?? new Error("Realtime turn cancelled."));
    signal?.addEventListener("abort", abort, { once: true });
    function finish(error?: unknown) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (ws.readyState === WebSocket.OPEN) ws.close();
      else if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
      if (error) {
        reject(error);
        return;
      }
      if (!text && audio.length === 0) {
        reject(
          new ApiError(502, "Azure returned no realtime audio or transcript."),
        );
        return;
      }
      const id = randomUUID();
      resolve({
        id,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: request.model,
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            logprobs: null,
            message: {
              role: "assistant",
              content: text || null,
              ...(audio.length
                ? {
                    audio: {
                      id,
                      data: realtimePcmToWav(Buffer.concat(audio)).toString(
                        "base64",
                      ),
                      transcript: text,
                      expires_at: Math.floor(Date.now() / 1000) + 3600,
                    },
                  }
                : {}),
            },
          },
        ],
        ...(usage ? { usage } : {}),
      });
    }
    const send = (event: unknown) => ws.send(JSON.stringify(event));
    ws.on("message", (raw) => {
      try {
        const event = JSON.parse(raw.toString()) as NativeEvent;
        if (event.type === "error") {
          finish(
            new ApiError(
              400,
              event.error?.message ?? "Azure realtime request failed.",
            ),
          );
          return;
        }
        if (event.type === "session.created") {
          send({
            type: "session.update",
            session: translation
              ? { audio: { output: { language: request.target_language } } }
              : {
                  type: "realtime",
                  instructions,
                  output_modalities: ["audio"],
                  audio: {
                    input: { turn_detection: null },
                    output: { voice: request.audio?.voice ?? "alloy" },
                  },
                  max_output_tokens: Math.min(
                    request.max_completion_tokens ?? request.max_tokens ?? 1024,
                    4096,
                  ),
                },
          });
        } else if (event.type === "session.updated" && !started) {
          started = true;
          if (translation && inputPcm) {
            for (let offset = 0; offset < inputPcm.length; offset += 9600)
              send({
                type: "session.input_audio_buffer.append",
                audio: inputPcm
                  .subarray(offset, offset + 9600)
                  .toString("base64"),
              });
            send({
              type: "session.input_audio_buffer.append",
              audio: Buffer.alloc(48000).toString("base64"),
            });
            send({ type: "session.close" });
          } else {
            for (const message of items) {
              const content =
                typeof message.content === "string"
                  ? [
                      {
                        type:
                          message.role === "assistant"
                            ? "output_text"
                            : "input_text",
                        text: message.content,
                      },
                    ]
                  : (message.content ?? []).flatMap(
                      (part): Record<string, unknown>[] => {
                        if (part.type === "text")
                          return [
                            {
                              type:
                                message.role === "assistant"
                                  ? "output_text"
                                  : "input_text",
                              text: part.text,
                            },
                          ];
                        if (part.type === "input_audio")
                          return [
                            {
                              type: "input_audio",
                              audio: decodeAudio(
                                part.input_audio.data,
                              ).toString("base64"),
                            },
                          ];
                        throw new ApiError(
                          400,
                          "Realtime turns accept text and PCM16 WAV audio.",
                        );
                      },
                    );
              if (content.length)
                send({
                  type: "conversation.item.create",
                  item: { type: "message", role: message.role, content },
                });
            }
            send({ type: "response.create" });
          }
        } else if (event.type.endsWith("audio.delta")) {
          const chunk = Buffer.from(event.delta ?? "", "base64");
          audioBytes += chunk.length;
          if (audioBytes > 16 * 1024 * 1024)
            throw new ApiError(
              502,
              "Realtime audio output exceeded the size limit.",
            );
          audio.push(chunk);
        } else if (
          event.type.endsWith("audio_transcript.delta") ||
          event.type === "session.output_transcript.delta" ||
          event.type === "response.output_text.delta"
        )
          text += event.delta ?? "";
        else if (event.type === "response.done") {
          if (event.response?.status !== "completed") {
            finish(
              new ApiError(502, "Azure realtime response did not complete."),
            );
            return;
          }
          const native = event.response.usage;
          if (native)
            usage = {
              prompt_tokens: native.input_tokens,
              completion_tokens: native.output_tokens,
              total_tokens: native.total_tokens,
            };
          finish();
        } else if (event.type === "session.closed" && translation) finish();
      } catch (error) {
        finish(error);
      }
    });
    ws.on("unexpected-response", (_request, response) => {
      response.resume();
      finish(
        new ApiError(
          response.statusCode && response.statusCode < 500
            ? response.statusCode
            : 502,
          `Azure realtime connection rejected (${response.statusCode}).`,
        ),
      );
    });
    ws.on("error", finish);
    ws.on("close", (code) => {
      if (!finished)
        finish(
          translation && code === 1000
            ? undefined
            : new ApiError(
                502,
                "Azure realtime connection closed before completion.",
              ),
        );
    });
  });
}

type NativeEvent = {
  type: string;
  delta?: string;
  error?: { message?: string };
  response?: {
    status?: string;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
    };
  };
};

function decodeAudio(data: string): Buffer {
  try {
    return wavToRealtimePcm(data);
  } catch (error) {
    throw new ApiError(
      400,
      error instanceof Error ? error.message : "Invalid WAV audio.",
    );
  }
}

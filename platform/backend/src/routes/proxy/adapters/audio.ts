import { randomUUID } from "node:crypto";
import OpenAI, { toFile } from "openai";
import config from "@/config";
import { ApiError, createStreamAccumulatorState } from "@/types";
import type {
  AudioAuditRequest,
  AudioAuditResponse,
  AudioOperation,
} from "@/types/audio";
import type { CommonMessage } from "@/types/common-llm-format";
import type {
  LLMProvider,
  LLMRequestAdapter,
  LLMResponseAdapter,
  LLMStreamAdapter,
  UsageView,
} from "@/types/llm-provider";
import { PROXY_BODY_LIMIT } from "../common";
import type { MediaMultipartFile } from "../utils/media-multipart";
import { azureAdapterFactory, getAzureClientForRequest } from "./azure";
import { openaiAdapterFactory } from "./openai";

type AudioChunk = {
  bytes?: Uint8Array;
  contentType: string;
  usage?: Record<string, unknown>;
  done?: boolean;
};
type AudioHeaders = { authorization?: string };
type AudioClient = { client: unknown; signal?: AbortSignal };

/** Upload bytes and request parameters stay in this request-scoped closure, outside audits. */
export function makeAudioAdapterFactory(params: {
  provider: "azure" | "openai";
  operation: AudioOperation;
  parameters: Record<string, unknown>;
  file?: MediaMultipartFile;
}): LLMProvider<
  AudioAuditRequest,
  AudioAuditResponse,
  CommonMessage[],
  AudioChunk,
  AudioHeaders
> {
  const { provider, operation, parameters, file } = params;
  const base =
    provider === "azure" ? azureAdapterFactory : openaiAdapterFactory;
  const sse = parameters.stream_format === "sse" || parameters.stream === true;
  return {
    provider,
    interactionType: `${provider}:audio`,
    spanName: "generate_content",
    unavailableUsageAccounting: true,
    cancelOnDisconnect: true,
    binaryStream: !sse,
    recordRequestDurationInHandler: true,
    getBaseUrl: base.getBaseUrl,
    extractApiKey: base.extractApiKey,
    extractErrorMessage: (error) =>
      error instanceof ApiError
        ? error.message
        : "Audio upstream request failed",
    extractInternalCode: base.extractInternalCode,
    createClient(apiKey, options): AudioClient {
      // Duration is reported by the handler. The general observable fetch logs
      // raw upstream error bodies, which may contain sensitive echoed audio.
      return {
        client: base.createClient(apiKey, { ...options, agent: undefined }),
        signal: options.abortSignal,
      };
    },
    createRequestAdapter: (request) =>
      new AudioRequestAdapter(provider, request),
    createResponseAdapter: (response) =>
      new AudioResponseAdapter(provider, response),
    createStreamAdapter: (request) =>
      new AudioStreamAdapter({
        provider,
        operation,
        model: request?.model ?? String(parameters.model),
        contentType: expectedContentType(operation, parameters),
        sse,
      }),
    async execute() {
      throw new ApiError(500, "Audio transport requires byte streaming");
    },
    async executeStream(client, request) {
      const audioClient = client as AudioClient;
      const sdk =
        provider === "azure"
          ? getAzureClientForRequest(audioClient.client, request.model)
          : (audioClient.client as OpenAI);
      const options = {
        signal: audioClient.signal,
        timeout: config.llmProxy.upstreamTimeoutMs ?? 600_000,
      };
      try {
        const body: Record<string, unknown> = {
          ...parameters,
          model: request.model,
        };
        let response: Response;
        if (operation === "speech") {
          response = await sdk.audio.speech
            .create(body as unknown as OpenAI.Audio.SpeechCreateParams, options)
            .asResponse();
        } else {
          if (!file) throw new ApiError(400, "Audio file is required");
          const upload = await toFile(file.data, file.filename, {
            type: file.mimetype,
          });
          if (operation === "transcriptions") {
            response =
              body.stream === true
                ? await sdk.audio.transcriptions
                    .create(
                      {
                        ...body,
                        file: upload,
                      } as unknown as OpenAI.Audio.TranscriptionCreateParamsStreaming,
                      options,
                    )
                    .asResponse()
                : await sdk.audio.transcriptions
                    .create(
                      {
                        ...body,
                        file: upload,
                      } as unknown as OpenAI.Audio.TranscriptionCreateParamsNonStreaming,
                      options,
                    )
                    .asResponse();
          } else {
            response = await sdk.audio.translations
              .create(
                {
                  ...body,
                  file: upload,
                } as unknown as OpenAI.Audio.TranslationCreateParams,
                options,
              )
              .asResponse();
          }
        }
        const contentType = response.headers.get("content-type") ?? "";
        const declaredLength = Number(response.headers.get("content-length"));
        if (
          Number.isFinite(declaredLength) &&
          declaredLength > PROXY_BODY_LIMIT
        ) {
          await response.body?.cancel();
          throw new ApiError(
            502,
            "Audio upstream response exceeds the size limit",
          );
        }
        const mime = contentType.split(";")[0].trim().toLowerCase();
        const valid = sse
          ? mime === "text/event-stream"
          : operation === "speech"
            ? mime.startsWith("audio/") || mime === "application/octet-stream"
            : String(parameters.response_format ?? "json").includes("json")
              ? mime === "application/json"
              : mime.startsWith("text/") || mime === "application/x-subrip";
        if (!valid || !response.body) {
          await response.body?.cancel();
          throw new ApiError(
            502,
            "Audio upstream returned an invalid content type or empty body",
          );
        }
        return readAudioResponse({
          response,
          contentType,
          json: mime === "application/json",
          sse,
        });
      } catch (error) {
        throw safeAudioError(error);
      }
    },
  };
}

class AudioRequestAdapter
  implements LLMRequestAdapter<AudioAuditRequest, CommonMessage[]>
{
  constructor(
    readonly provider: "azure" | "openai",
    private request: AudioAuditRequest,
  ) {}
  getModel() {
    return this.request.model;
  }
  setModel(model: string) {
    this.request = { ...this.request, model };
  }
  isStreaming() {
    return true;
  }
  getMessages(): CommonMessage[] {
    return [];
  }
  getProviderMessages(): CommonMessage[] {
    return [];
  }
  getTools() {
    return [];
  }
  getToolResults() {
    return [];
  }
  hasTools() {
    return false;
  }
  getOriginalRequest() {
    return this.request;
  }
  toProviderRequest() {
    return this.request;
  }
  updateToolResult() {}
  applyToolResultUpdates() {}
  convertToolResultContent(messages: CommonMessage[]) {
    return messages;
  }
}

class AudioResponseAdapter implements LLMResponseAdapter<AudioAuditResponse> {
  constructor(
    readonly provider: "azure" | "openai",
    private readonly response: AudioAuditResponse,
  ) {}
  getId() {
    return this.response.id;
  }
  getModel() {
    return this.response.model;
  }
  getText() {
    return "";
  }
  getToolCalls() {
    return [];
  }
  hasToolCalls() {
    return false;
  }
  getUsage() {
    return audioUsage(this.response.usage);
  }
  getOriginalResponse() {
    return this.response;
  }
  getFinishReasons() {
    return ["stop"];
  }
  toRefusalResponse() {
    return this.response;
  }
}

class AudioStreamAdapter
  implements LLMStreamAdapter<AudioChunk, AudioAuditResponse>
{
  readonly provider: "azure" | "openai";
  readonly state = createStreamAccumulatorState();
  private contentType: string;
  private bytes = 0;
  private usage?: Record<string, unknown>;
  constructor(
    private readonly options: {
      provider: "azure" | "openai";
      operation: AudioOperation;
      model: string;
      contentType: string;
      sse: boolean;
    },
  ) {
    this.provider = options.provider;
    this.contentType = options.contentType;
    this.state.responseId = randomUUID();
    this.state.model = options.model;
  }
  processChunk(chunk: AudioChunk) {
    this.contentType = chunk.contentType;
    this.bytes += chunk.bytes?.byteLength ?? 0;
    if (chunk.usage) this.usage = chunk.usage;
    if (chunk.done) {
      this.state.usage = audioUsage(this.usage);
      this.state.stopReason = "stop";
    }
    return {
      sseData: chunk.bytes ?? null,
      isToolCallChunk: false,
      isFinal: chunk.done === true,
    };
  }
  getSSEHeaders() {
    return {
      "Content-Type": this.contentType,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    };
  }
  getRawToolCallEvents() {
    return [];
  }
  formatTextDeltaSSE(): string {
    throw new ApiError(422, "Audio content cannot be replaced by text");
  }
  formatCompleteTextSSE(): string[] {
    throw new ApiError(422, "Audio content cannot be replaced by text");
  }
  formatEndSSE() {
    return "";
  }
  toProviderResponse(): AudioAuditResponse {
    return {
      id: this.state.responseId,
      model: this.state.model,
      operation: this.options.operation,
      content_type: this.contentType,
      bytes: this.bytes,
      usage_available: this.usage !== undefined,
      cost_available: false,
      ...(this.usage ? { usage: this.usage } : {}),
    };
  }
}

async function* readAudioResponse(params: {
  response: Response;
  contentType: string;
  json: boolean;
  sse: boolean;
}): AsyncGenerator<AudioChunk> {
  const reader = params.response.body?.getReader();
  if (!reader) throw new ApiError(502, "Audio upstream returned an empty body");
  let total = 0;
  const chunks: Uint8Array[] = [];
  const decoder = new TextDecoder();
  let pending = "";
  let usage: Record<string, unknown> | undefined;
  let terminal = false;
  try {
    for (;;) {
      const next = await readWithDeadline(reader);
      if (next.done) break;
      total += next.value.byteLength;
      if (total > PROXY_BODY_LIMIT)
        throw new ApiError(
          502,
          "Audio upstream response exceeds the size limit",
        );
      if (params.json) {
        chunks.push(next.value);
        continue;
      }
      if (params.sse) {
        pending = (
          pending + decoder.decode(next.value, { stream: true })
        ).replaceAll("\r\n", "\n");
        let end = pending.indexOf("\n\n");
        while (end >= 0) {
          const event = pending.slice(0, end);
          pending = pending.slice(end + 2);
          const data = event
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (data && data !== "[DONE]") {
            const parsed = JSON.parse(data) as Record<string, unknown>;
            if (parsed.type === "error" || parsed.error)
              throw new ApiError(502, "Audio upstream stream failed");
            usage = safeUsage(parsed.usage) ?? usage;
            terminal ||=
              parsed.type === "transcript.text.done" ||
              parsed.type === "speech.audio.done";
          }
          end = pending.indexOf("\n\n");
        }
        if (pending.length > 1024 * 1024)
          throw new ApiError(
            502,
            "Audio upstream event exceeds the size limit",
          );
      }
      yield { bytes: next.value, contentType: params.contentType };
    }
    if (!total || (params.sse && (!terminal || pending.trim())))
      throw new ApiError(
        502,
        "Audio upstream response ended before completion",
      );
    if (params.json) {
      const bytes = Buffer.concat(chunks);
      const value = JSON.parse(bytes.toString()) as Record<string, unknown>;
      if (typeof value.text !== "string")
        throw new ApiError(
          502,
          "Audio upstream returned an invalid transcript",
        );
      usage = safeUsage(value.usage);
      yield { bytes, contentType: params.contentType };
    }
    yield { contentType: params.contentType, usage, done: true };
  } catch (error) {
    throw safeAudioError(error);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function readWithDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ApiError(504, "Audio upstream response timed out")),
          config.llmProxy.upstreamTimeoutMs || 600_000,
        );
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function safeUsage(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object") return;
  const record = raw as Record<string, unknown>;
  const entries = [
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "seconds",
  ].flatMap((key) =>
    typeof record[key] === "number" &&
    Number.isFinite(record[key]) &&
    record[key] >= 0
      ? [[key, record[key]]]
      : [],
  );
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function audioUsage(usage?: Record<string, unknown>): UsageView {
  const known =
    typeof usage?.input_tokens === "number" &&
    typeof usage?.output_tokens === "number";
  return {
    inputTokens: known ? Number(usage.input_tokens) : 0,
    outputTokens: known ? Number(usage.output_tokens) : 0,
    usageUnavailable: !known,
    costUnavailable: true,
  };
}

function expectedContentType(
  operation: AudioOperation,
  parameters: Record<string, unknown>,
) {
  if (parameters.stream_format === "sse" || parameters.stream === true)
    return "text/event-stream";
  if (operation === "speech")
    return `audio/${parameters.response_format ?? "mpeg"}`;
  return String(parameters.response_format ?? "json").includes("json")
    ? "application/json"
    : "text/plain";
}

function safeAudioError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  const status =
    error instanceof OpenAI.APIError && error.status
      ? error.status
      : error instanceof OpenAI.APIConnectionTimeoutError
        ? 504
        : 502;
  const safe = new ApiError(status, "Audio upstream request failed");
  if (error instanceof OpenAI.APIError) {
    const retryAfter = error.headers?.get("retry-after");
    if (retryAfter && retryAfter.length <= 128)
      Object.assign(safe, {
        headers: new Headers({ "retry-after": retryAfter }),
      });
  }
  return safe;
}

import {
  APICallError,
  type LanguageModel,
  UnsupportedFunctionalityError,
} from "ai";

type NativeModel = Extract<LanguageModel, { specificationVersion: "v3" }>;
type CallOptions = Parameters<NativeModel["doGenerate"]>[0];
type GenerateResult = Awaited<ReturnType<NativeModel["doGenerate"]>>;
type StreamPart =
  Awaited<ReturnType<NativeModel["doStream"]>>["stream"] extends ReadableStream<
    infer Part
  >
    ? Part
    : never;

/** Expose native Azure image/audio output as files in the existing Chat stream. */
export function createAzureMediaLanguageModel(params: {
  modelId: string;
  baseURL: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  kind: "image" | "audio" | "realtime" | "translation";
}): NativeModel {
  const generate = async (options: CallOptions): Promise<GenerateResult> => {
    const prompt = latestUserText(options);
    if (params.kind === "translation") {
      const latest = options.prompt.findLast(
        (message) => message.role === "user",
      );
      if (
        !latest?.content.some(
          (part) =>
            part.type === "file" &&
            ["audio/wav", "audio/x-wav"].includes(part.mediaType),
        )
      )
        throw new UnsupportedFunctionalityError({
          functionality:
            "translation without a WAV attachment in this message. Attach a WAV file and enter the target language code, for example es for Spanish.",
        });
    }
    const body =
      params.kind === "image"
        ? {
            model: params.modelId,
            prompt,
            n: 1,
            size: "1024x1024",
            quality: "low",
          }
        : {
            model: params.modelId,
            messages: audioMessages(options, params.kind !== "audio"),
            modalities: ["text", "audio"],
            audio: { voice: "alloy", format: "wav" },
            max_completion_tokens: options.maxOutputTokens ?? 1024,
            ...(params.kind === "translation"
              ? { target_language: translationLanguage(prompt) }
              : {}),
          };
    const url = `${params.baseURL.replace(/\/+$/, "")}/${params.kind === "image" ? "images/generations" : params.kind === "audio" ? "chat/completions" : "realtime/turns"}`;
    const response = await (params.fetch ?? fetch)(url, {
      method: "POST",
      headers: {
        ...params.headers,
        "content-type": "application/json",
        ...options.headers,
      },
      body: JSON.stringify(body),
      signal: options.abortSignal,
    });
    const responseText = await response.text();
    if (!response.ok) {
      throw new APICallError({
        message: providerError(responseText),
        url,
        requestBodyValues: body,
        statusCode: response.status,
        responseBody: responseText,
      });
    }
    const data = JSON.parse(responseText) as MediaResponse;
    const content: GenerateResult["content"] = [];
    if (params.kind === "image") {
      for (const image of data.data ?? []) {
        if (image.b64_json)
          content.push({
            type: "file",
            mediaType: "image/png",
            data: image.b64_json,
          });
      }
    } else {
      const message = data.choices?.[0]?.message;
      const text = message?.audio?.transcript ?? message?.content;
      if (text) content.push({ type: "text", text });
      if (message?.audio?.data)
        content.push({
          type: "file",
          mediaType: "audio/wav",
          data: message.audio.data,
        });
    }
    if (content.length === 0)
      throw new Error("The provider returned no generated media.");
    const input = data.usage?.input_tokens ?? data.usage?.prompt_tokens;
    const output = data.usage?.output_tokens ?? data.usage?.completion_tokens;
    return {
      content,
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: {
          total: input,
          noCache: input,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: { total: output, text: undefined, reasoning: undefined },
      },
      warnings: options.tools?.length
        ? [
            {
              type: "unsupported",
              feature: "tools",
              details:
                "This media model generates files and does not call agent tools.",
            },
          ]
        : [],
      response: { modelId: params.modelId, body: data },
    };
  };
  return {
    specificationVersion: "v3",
    provider: "azure.media",
    modelId: params.modelId,
    supportedUrls: {},
    doGenerate: generate,
    async doStream(options) {
      const result = await generate(options);
      const parts: StreamPart[] = [
        { type: "stream-start", warnings: result.warnings },
      ];
      for (const item of result.content) {
        if (item.type === "text") {
          parts.push(
            { type: "text-start", id: "text" },
            { type: "text-delta", id: "text", delta: item.text },
            { type: "text-end", id: "text" },
          );
        } else if (item.type === "file") parts.push(item);
      }
      parts.push({
        type: "finish",
        finishReason: result.finishReason,
        usage: result.usage,
      });
      return {
        stream: new ReadableStream<StreamPart>({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  };
}

function latestUserText(options: CallOptions): string {
  const user = options.prompt.findLast((message) => message.role === "user");
  return (
    user?.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n") ?? ""
  );
}

function audioMessages(options: CallOptions, wavOnly: boolean) {
  const messages: {
    role: string;
    content: string | Record<string, unknown>[];
  }[] = [];
  for (const message of options.prompt) {
    if (message.role === "system") {
      messages.push({ role: "system", content: message.content });
      continue;
    }
    if (message.role !== "user" && message.role !== "assistant") continue;
    const content: Record<string, unknown>[] = [];
    for (const part of message.content) {
      if (part.type === "text") {
        content.push({ type: "text", text: part.text });
        continue;
      }
      // Prior assistant speech already has a transcript. Replaying its WAV as
      // input_audio is invalid for assistant messages on the native audio API.
      if (
        message.role !== "user" ||
        part.type !== "file" ||
        !part.mediaType.startsWith("audio/")
      )
        continue;
      if (part.data instanceof URL)
        throw new UnsupportedFunctionalityError({
          functionality:
            "audio URLs. Upload the audio file before sending this message.",
        });
      const format = ["audio/wav", "audio/x-wav"].includes(part.mediaType)
        ? "wav"
        : ["audio/mpeg", "audio/mp3"].includes(part.mediaType)
          ? "mp3"
          : undefined;
      if (!format || (wavOnly && format !== "wav"))
        throw new UnsupportedFunctionalityError({
          functionality: wavOnly
            ? "this audio format for realtime turns. Attach a PCM16 WAV file."
            : "this audio format. Attach a WAV or MP3 file.",
        });
      content.push({
        type: "input_audio",
        input_audio: {
          data:
            typeof part.data === "string"
              ? part.data
              : Buffer.from(part.data).toString("base64"),
          format,
        },
      });
    }
    if (content.length) messages.push({ role: message.role, content });
  }
  return messages;
}

function providerError(raw: string): string {
  try {
    return JSON.parse(raw).error?.message ?? "Azure media request failed";
  } catch {
    return "Azure media request failed";
  }
}

type MediaResponse = {
  data?: { b64_json?: string }[];
  choices?: {
    message?: {
      content?: string | null;
      audio?: { data?: string; transcript?: string };
    };
  }[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  };
};

function translationLanguage(prompt: string): string {
  const code = prompt.trim();
  if (!/^[a-z]{2,3}(?:-[A-Za-z]{2,8})?$/.test(code))
    throw new UnsupportedFunctionalityError({
      functionality:
        "translation without a target language code. Enter only a language code, for example es for Spanish.",
    });
  return code;
}

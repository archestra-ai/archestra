import { generateText, streamText, UnsupportedFunctionalityError } from "ai";
import { describe, expect, test, vi } from "vitest";
import { createAzureMediaLanguageModel } from "./azure-media-language-model";

describe("Azure media Chat transport", () => {
  test("requires a new WAV attachment for each translation message", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const model = createAzureMediaLanguageModel({
      modelId: "gpt-realtime-translate",
      kind: "translation",
      baseURL: "https://proxy.example/v1/azure",
      fetch,
    });
    let error: unknown;
    try {
      await generateText({
        model,
        maxRetries: 0,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "file",
                mediaType: "audio/wav",
                data: Buffer.from("audio"),
              },
              { type: "text", text: "es" },
            ],
          },
          { role: "assistant", content: "Hola." },
          { role: "user", content: "es" },
        ],
      });
    } catch (caught) {
      error = caught;
    }
    expect(UnsupportedFunctionalityError.isInstance(error)).toBe(true);
    expect(error).toMatchObject({
      functionality: expect.stringContaining("WAV attachment in this message"),
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  test("rejects ordinary text as a translation language code with actionable guidance", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const model = createAzureMediaLanguageModel({
      modelId: "gpt-realtime-translate",
      kind: "translation",
      baseURL: "https://proxy.example/v1/azure",
      fetch,
    });
    await expect(
      generateText({
        model,
        maxRetries: 0,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "file",
                mediaType: "audio/wav",
                data: Buffer.from("audio"),
              },
              { type: "text", text: "say hello in Spanish" },
            ],
          },
        ],
      }),
    ).rejects.toMatchObject({
      functionality: expect.stringContaining("Enter only a language code"),
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  test("rejects MP3 realtime input before calling the proxy", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const model = createAzureMediaLanguageModel({
      modelId: "gpt-realtime-2.1",
      kind: "realtime",
      baseURL: "https://proxy.example/v1/azure",
      fetch,
    });
    await expect(
      generateText({
        model,
        maxRetries: 0,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "file",
                mediaType: "audio/mpeg",
                data: Buffer.from("audio"),
              },
              { type: "text", text: "Reply briefly." },
            ],
          },
        ],
      }),
    ).rejects.toMatchObject({
      functionality: expect.stringContaining("Attach a PCM16 WAV file"),
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  test("sends a current WAV attachment and valid language code to realtime translation", async () => {
    const model = createAzureMediaLanguageModel({
      modelId: "gpt-realtime-translate",
      kind: "translation",
      baseURL: "https://proxy.example/v1/azure",
      fetch: async (_url, init) => {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          target_language: "es",
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "input_audio",
                  input_audio: { format: "wav", data: "YXVkaW8=" },
                },
                { type: "text", text: "es" },
              ],
            },
          ],
        });
        return Response.json({
          choices: [
            { message: { audio: { data: "c3BlZWNo", transcript: "Hola." } } },
          ],
        });
      },
    });
    const result = await generateText({
      model,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "file",
              mediaType: "audio/wav",
              data: Buffer.from("audio"),
            },
            { type: "text", text: "es" },
          ],
        },
      ],
    });
    expect(result.text).toBe("Hola.");
  });

  test("sends an image prompt to the images API and exposes a file in the Chat stream", async () => {
    const requests: { url: string; body: Record<string, unknown> }[] = [];
    const model = createAzureMediaLanguageModel({
      modelId: "gpt-image-1",
      kind: "image",
      baseURL: "https://proxy.example/v1/azure/agent",
      headers: { authorization: "Bearer platform-token" },
      fetch: async (url, init) => {
        requests.push({
          url: String(url),
          body: JSON.parse(String(init?.body)),
        });
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer platform-token",
        );
        return Response.json({
          created: 1,
          data: [{ b64_json: "aW1hZ2U=" }],
          usage: { input_tokens: 3, output_tokens: 4 },
        });
      },
    });
    const result = streamText({ model, prompt: "Draw a blue circle." });
    const parts: { type: string }[] = [];
    for await (const part of result.fullStream) parts.push(part);
    expect(requests).toEqual([
      {
        url: "https://proxy.example/v1/azure/agent/images/generations",
        body: {
          model: "gpt-image-1",
          prompt: "Draw a blue circle.",
          n: 1,
          size: "1024x1024",
          quality: "low",
        },
      },
    ]);
    expect(parts.some((part) => part.type === "file")).toBe(true);
    expect((await result.files)[0]).toMatchObject({
      mediaType: "image/png",
      base64: "aW1hZ2U=",
    });
    expect(await result.usage).toMatchObject({
      inputTokens: 3,
      outputTokens: 4,
    });
  });

  test("keeps uploaded audio, asks for speech, and returns playable audio plus its transcript", async () => {
    const model = createAzureMediaLanguageModel({
      modelId: "gpt-audio",
      kind: "audio",
      baseURL: "https://proxy.example/v1/azure",
      fetch: async (_url, init) => {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          model: "gpt-audio",
          modalities: ["text", "audio"],
          audio: { format: "wav", voice: "alloy" },
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "input_audio",
                  input_audio: { data: "YXVkaW8=", format: "wav" },
                },
                { type: "text", text: "Reply briefly." },
              ],
            },
          ],
        });
        return Response.json({
          choices: [
            {
              message: {
                content: null,
                audio: { data: "c3BlZWNo", transcript: "Hello." },
              },
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 6 },
        });
      },
    });
    const result = await generateText({
      model,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "file",
              mediaType: "audio/wav",
              data: Buffer.from("audio"),
            },
            { type: "text", text: "Reply briefly." },
          ],
        },
      ],
    });
    expect(result.text).toBe("Hello.");
    expect(result.files[0]).toMatchObject({
      mediaType: "audio/wav",
      base64: "c3BlZWNo",
    });
  });

  test("replays assistant speech as its transcript on a follow-up", async () => {
    const model = createAzureMediaLanguageModel({
      modelId: "gpt-audio",
      kind: "audio",
      baseURL: "https://proxy.example/v1/azure",
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.messages).toEqual([
          { role: "user", content: [{ type: "text", text: "Say hello." }] },
          { role: "assistant", content: [{ type: "text", text: "Hello." }] },
          { role: "user", content: [{ type: "text", text: "Say goodbye." }] },
        ]);
        return Response.json({
          choices: [
            {
              message: { audio: { data: "c3BlZWNo", transcript: "Goodbye." } },
            },
          ],
        });
      },
    });
    const result = await generateText({
      model,
      messages: [
        { role: "user", content: "Say hello." },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Hello." },
            {
              type: "file",
              mediaType: "audio/wav",
              data: Buffer.from("speech"),
            },
          ],
        },
        { role: "user", content: "Say goodbye." },
      ],
    });
    expect(result.text).toBe("Goodbye.");
  });

  test("preserves provider error status instead of reporting empty media as success", async () => {
    const model = createAzureMediaLanguageModel({
      modelId: "gpt-image-1",
      kind: "image",
      baseURL: "https://proxy.example",
      fetch: async () =>
        Response.json(
          { error: { message: "Deployment unavailable" } },
          { status: 404 },
        ),
    });
    await expect(
      generateText({ model, prompt: "Draw a circle.", maxRetries: 0 }),
    ).rejects.toMatchObject({
      statusCode: 404,
      message: "Deployment unavailable",
    });
  });

  test("does not accept a provider response with no image output", async () => {
    const model = createAzureMediaLanguageModel({
      modelId: "gpt-image-1",
      kind: "image",
      baseURL: "https://proxy.example",
      fetch: async () => Response.json({ created: 1, data: [] }),
    });
    await expect(
      generateText({ model, prompt: "Draw a circle.", maxRetries: 0 }),
    ).rejects.toThrow("no generated media");
  });
});

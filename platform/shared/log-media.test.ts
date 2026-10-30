import { describe, expect, it } from "vitest";
import {
  isMediaNotKept,
  MEDIA_NOT_KEPT,
  withoutLoggedMedia,
} from "./log-media";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAE=";
const WAV = "UklGRiQAAABXQVZFZm10IBAAAAA=";

describe("withoutLoggedMedia", () => {
  it("drops images, audio and files from an OpenAI chat request and its spoken reply", () => {
    const request = {
      model: "gpt-audio",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What is in this picture?" },
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${PNG}` },
            },
            { type: "input_audio", input_audio: { data: WAV, format: "wav" } },
            {
              type: "file",
              file: {
                filename: "brief.pdf",
                file_data: `data:application/pdf;base64,${PNG}`,
              },
            },
          ],
        },
      ],
    };
    expect(withoutLoggedMedia(request).messages[0].content).toEqual([
      { type: "text", text: "What is in this picture?" },
      {
        type: "image_url",
        image_url: { url: `data:image/png;${MEDIA_NOT_KEPT},` },
      },
      {
        type: "input_audio",
        input_audio: { data: MEDIA_NOT_KEPT, format: "wav" },
      },
      {
        type: "file",
        file: {
          filename: "brief.pdf",
          file_data: `data:application/pdf;${MEDIA_NOT_KEPT},`,
        },
      },
    ]);
    const reply = {
      choices: [
        {
          message: {
            role: "assistant",
            audio: { id: "audio_1", data: WAV, transcript: "Hello" },
          },
        },
      ],
    };
    expect(withoutLoggedMedia(reply).choices[0].message.audio).toEqual({
      id: "audio_1",
      data: MEDIA_NOT_KEPT,
      transcript: "Hello",
    });
  });

  it("drops Anthropic, Gemini, Bedrock and Ollama media", () => {
    expect(
      withoutLoggedMedia({
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: PNG },
          },
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: PNG,
            },
          },
        ],
      }).content.map((part) => part.source.data),
    ).toEqual([MEDIA_NOT_KEPT, MEDIA_NOT_KEPT]);
    expect(
      withoutLoggedMedia({
        parts: [
          { text: "Make it red" },
          { inlineData: { mimeType: "image/png", data: PNG } },
          { fileData: { mimeType: "image/png", fileUri: "gs://b/x.png" } },
        ],
      }).parts,
    ).toEqual([
      { text: "Make it red" },
      { inlineData: { mimeType: "image/png", data: MEDIA_NOT_KEPT } },
      { fileData: { mimeType: "image/png", fileUri: "gs://b/x.png" } },
    ]);
    expect(
      withoutLoggedMedia({
        image: { format: "png", source: { bytes: PNG } },
      }),
    ).toEqual({ image: { format: "png", source: { bytes: MEDIA_NOT_KEPT } } });
    for (const format of ["txt", "csv", "docx", "pdf"])
      expect(
        withoutLoggedMedia({
          document: { format, name: "document", source: { bytes: PNG } },
        }).document.source.bytes,
      ).toBe(MEDIA_NOT_KEPT);
    expect(
      withoutLoggedMedia({
        video: { format: "mp4", source: { bytes: PNG } },
      }).video.source.bytes,
    ).toBe(MEDIA_NOT_KEPT);
    expect(
      withoutLoggedMedia({
        messages: [{ role: "user", content: "hi", images: [PNG] }],
      }).messages[0].images,
    ).toEqual([MEDIA_NOT_KEPT]);
  });

  it("drops generated images, kept clips, edit uploads and Responses images", () => {
    expect(
      withoutLoggedMedia({ data: [{ b64_json: PNG, revised_prompt: "x" }] }),
    ).toEqual({ data: [{ b64_json: MEDIA_NOT_KEPT, revised_prompt: "x" }] });
    expect(
      withoutLoggedMedia({
        speech_input: "Hello",
        audio: { content_type: "audio/mpeg", data: WAV },
        output_audio: { format: "pcm16", sample_rate: 24000, data: WAV },
      }),
    ).toEqual({
      speech_input: "Hello",
      audio: { content_type: "audio/mpeg", data: MEDIA_NOT_KEPT },
      output_audio: {
        format: "pcm16",
        sample_rate: 24000,
        data: MEDIA_NOT_KEPT,
      },
    });
    expect(
      withoutLoggedMedia({
        input_files: {
          images: [
            {
              filename: "circle.png",
              mime_type: "image/png",
              bytes: 9,
              data: PNG,
            },
          ],
        },
      }).input_files.images[0],
    ).toEqual({
      filename: "circle.png",
      mime_type: "image/png",
      bytes: 9,
      data: MEDIA_NOT_KEPT,
    });
    expect(
      withoutLoggedMedia({
        output: [
          { type: "image_generation_call", id: "ig_1", result: PNG },
          { type: "input_image", image_url: `data:image/webp;base64,${PNG}` },
        ],
      }).output,
    ).toEqual([
      { type: "image_generation_call", id: "ig_1", result: MEDIA_NOT_KEPT },
      { type: "input_image", image_url: `data:image/webp;${MEDIA_NOT_KEPT},` },
    ]);
  });

  it("drops MCP tool result media, also when a tool result reaches a model as JSON text", () => {
    const result = {
      content: [
        { type: "text", text: "Screenshot taken" },
        { type: "image", data: PNG, mimeType: "image/png" },
        { type: "audio", data: WAV, mimeType: "audio/wav" },
        {
          type: "resource",
          resource: {
            uri: "file:///a.pdf",
            mimeType: "application/pdf",
            blob: PNG,
          },
        },
      ],
    };
    const stripped = withoutLoggedMedia(result);
    expect(stripped.content.map((part) => JSON.stringify(part))).not.toContain(
      PNG,
    );
    expect(JSON.stringify(stripped)).not.toContain(PNG);
    expect(JSON.stringify(stripped)).not.toContain(WAV);
    expect(stripped.content[0]).toEqual({
      type: "text",
      text: "Screenshot taken",
    });

    const toolMessage = { role: "tool", content: JSON.stringify(result) };
    const strippedMessage = withoutLoggedMedia(toolMessage);
    expect(strippedMessage.content).not.toContain(PNG);
    expect(JSON.parse(strippedMessage.content).content[1]).toEqual({
      type: "image",
      data: MEDIA_NOT_KEPT,
      mimeType: "image/png",
    });
  });

  it("drops a data URL inside text and keeps the text around it", () => {
    expect(
      withoutLoggedMedia({
        text: `Here: ![chart](data:image/png;base64,${PNG}) and done.`,
      }).text,
    ).toBe(`Here: ![chart](data:image/png;${MEDIA_NOT_KEPT},) and done.`);
  });

  it("leaves text, links, signatures, tool arguments and vectors alone, as the same object", () => {
    const request = {
      model: "claude",
      messages: [
        { role: "user", content: "Reply with exactly: hi" },
        {
          role: "assistant",
          content: [
            { type: "redacted_thinking", data: "EmwKAhgBEgy3va3pzix" },
            { type: "thinking", thinking: "x", signature: "ErUBCkYIBBgC" },
            {
              type: "tool_use",
              id: "t1",
              name: "write",
              input: { path: "a.csv", data: "a,b" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "url", url: "https://example.com/cat.png" },
            },
          ],
        },
      ],
      tools: [
        {
          name: "write",
          input_schema: { properties: { format: { type: "string" } } },
        },
      ],
    };
    expect(withoutLoggedMedia(request)).toBe(request);
    const embedding = { data: [{ embedding: "AAAAPwAAgD8=", index: 0 }] };
    expect(withoutLoggedMedia(embedding)).toBe(embedding);
    expect(withoutLoggedMedia("[Image #1] see above")).toBe(
      "[Image #1] see above",
    );
  });

  it("keeps tool text that only looks like a media container", () => {
    const toolCall = {
      arguments: {
        source: { data: "hello" },
        upload: { data: "aGVsbG8=" },
        record: { bytes: "c2VjcmV0", blob: "YmxvYg==" },
        images: ["aGVsbG8="],
      },
    };
    expect(withoutLoggedMedia(toolCall)).toBe(toolCall);
    const document = {
      type: "document",
      source: { type: "text", media_type: "text/plain", data: "hello" },
    };
    expect(withoutLoggedMedia(document)).toBe(document);
    const settings = { format: "json", source: { data: "hello" } };
    expect(withoutLoggedMedia(settings)).toBe(settings);
  });

  it("bounds nesting, also inside JSON text, and the result serializes", () => {
    let deep: unknown = { type: "image", data: PNG, mimeType: "image/png" };
    for (let index = 0; index < 20_000; index++) deep = { a: deep };

    const stripped = withoutLoggedMedia({ content: deep });
    const serialized = JSON.stringify(stripped);
    expect(serialized).toContain("[nested too deeply to log]");
    expect(serialized).not.toContain(PNG);

    let text = '{"type":"text","text":"x"}';
    for (let index = 0; index < 20_000; index++) text = `{"a":${text}}`;
    const message = withoutLoggedMedia({ role: "tool", content: text });
    expect(message.content).toContain("[nested too deeply to log]");
    expect(message.content.length).toBeLessThan(1_000);
  });
});

describe("isMediaNotKept", () => {
  it("recognizes both markers and nothing else", () => {
    expect(isMediaNotKept(MEDIA_NOT_KEPT)).toBe(true);
    expect(isMediaNotKept(`data:image/png;${MEDIA_NOT_KEPT},`)).toBe(true);
    expect(isMediaNotKept(`data:image/png;base64,${PNG}`)).toBe(false);
    expect(isMediaNotKept(PNG)).toBe(false);
    expect(isMediaNotKept(undefined)).toBe(false);
  });
});

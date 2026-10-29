import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { policyView } from "./result-view";

const bytes = Buffer.from("not really a png, but stable bytes".repeat(100));
const b64 = bytes.toString("base64");
const digest = createHash("sha256").update(bytes).digest("hex");
const marker = (type: string) =>
  `[binary ${type}, ${bytes.length} bytes, sha256 ${digest}]`;

describe("policyView", () => {
  test("the marker states media type, decoded size and the hash of the decoded bytes", () => {
    const view = policyView([
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: b64 },
      },
    ]);
    expect(view).toEqual([
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: marker("image/png"),
        },
      },
    ]);
  });

  test("is stable for the same bytes and differs for different bytes", () => {
    const view = (data: string) =>
      JSON.stringify(
        policyView([{ type: "image", data, mimeType: "image/png" }]),
      );
    expect(view(b64)).toBe(view(b64));
    expect(view(b64)).not.toBe(
      view(Buffer.from("other bytes!").toString("base64")),
    );
  });

  test("keeps text in full and does not touch the input", () => {
    const content = [
      { type: "text", text: "Read the file" },
      { type: "image", data: b64, mimeType: "image/png" },
    ];
    const view = policyView(content) as typeof content;
    expect(view[0]).toBe(content[0]);
    expect(view[1].data).toBe(marker("image/png"));
    expect(content[1].data).toBe(b64);
  });

  test("returns the same value, not a copy, when nothing is binary", () => {
    const content = [{ type: "text", text: "plain" }, { ok: true }];
    expect(policyView(content)).toBe(content);
    expect(policyView("a string")).toBe("a string");
  });

  describe.each([
    [
      "anthropic image",
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: b64 },
      },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: marker("image/png"),
        },
      },
    ],
    [
      "anthropic document",
      {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: b64 },
      },
      {
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: marker("application/pdf"),
        },
      },
    ],
    [
      "mcp image",
      { type: "image", data: b64, mimeType: "image/jpeg" },
      { type: "image", data: marker("image/jpeg"), mimeType: "image/jpeg" },
    ],
    [
      "mcp audio",
      { type: "audio", data: b64, mimeType: "audio/wav" },
      { type: "audio", data: marker("audio/wav"), mimeType: "audio/wav" },
    ],
    [
      "mcp resource blob",
      {
        type: "resource",
        resource: { uri: "file:///a", blob: b64, mimeType: "application/zip" },
      },
      {
        type: "resource",
        resource: {
          uri: "file:///a",
          blob: marker("application/zip"),
          mimeType: "application/zip",
        },
      },
    ],
    [
      "responses input_image",
      { type: "input_image", image_url: `data:image/png;base64,${b64}` },
      { type: "input_image", image_url: marker("image/png") },
    ],
    [
      "responses input_file",
      {
        type: "input_file",
        file_data: `data:application/pdf;base64,${b64}`,
        filename: "a.pdf",
      },
      {
        type: "input_file",
        file_data: marker("application/pdf"),
        filename: "a.pdf",
      },
    ],
    [
      "chat image_url",
      {
        type: "image_url",
        image_url: { url: `data:image/webp;base64,${b64}`, detail: "low" },
      },
      {
        type: "image_url",
        image_url: { url: marker("image/webp"), detail: "low" },
      },
    ],
    [
      "chat input_audio",
      { type: "input_audio", input_audio: { data: b64, format: "mp3" } },
      {
        type: "input_audio",
        input_audio: { data: marker("audio/mp3"), format: "mp3" },
      },
    ],
    [
      "chat file",
      {
        type: "file",
        file: {
          file_data: `data:application/pdf;base64,${b64}`,
          filename: "a.pdf",
        },
      },
      {
        type: "file",
        file: { file_data: marker("application/pdf"), filename: "a.pdf" },
      },
    ],
    [
      "bedrock image",
      { image: { format: "png", source: { bytes: b64 } } },
      { image: { format: "png", source: { bytes: marker("image/png") } } },
    ],
    [
      "bedrock document",
      { document: { format: "pdf", name: "a", source: { bytes: b64 } } },
      {
        document: {
          format: "pdf",
          name: "a",
          source: { bytes: marker("document/pdf") },
        },
      },
    ],
    [
      "bedrock video",
      { video: { format: "mp4", source: { bytes: b64 } } },
      { video: { format: "mp4", source: { bytes: marker("video/mp4") } } },
    ],
    [
      "gemini inlineData",
      { inlineData: { mimeType: "image/png", data: b64 } },
      { inlineData: { mimeType: "image/png", data: marker("image/png") } },
    ],
  ])("%s", (_name, part, expected) => {
    test("replaces the payload with its marker", () => {
      expect(policyView(part)).toEqual(expected);
    });

    test("finds the part nested in a result", () => {
      expect(
        policyView({ content: [{ type: "text", text: "x" }, part] }),
      ).toEqual({ content: [{ type: "text", text: "x" }, expected] });
    });
  });

  test.each([
    [
      "a payload that is not base64",
      { type: "image", data: "not base64!!", mimeType: "image/png" },
    ],
    [
      "a payload no byte string encodes",
      { type: "image", data: "QUJDR", mimeType: "image/png" },
    ],
    [
      "a remote url",
      {
        type: "image",
        source: { type: "url", url: "https://example.com/a.png" },
      },
    ],
    [
      "a remote image_url",
      { type: "image_url", image_url: { url: "https://example.com/a.png" } },
    ],
    [
      "a data url that is not base64",
      { type: "input_image", image_url: "data:text/plain,hello" },
    ],
    [
      "an anthropic text document",
      {
        type: "document",
        source: { type: "text", media_type: "text/plain", data: "hello" },
      },
    ],
    ["an unrecognised shape", { type: "custom", data: b64 }],
  ])("leaves %s untouched", (_name, part) => {
    expect(policyView(part)).toBe(part);
  });

  test("applies at every size", () => {
    const tiny = Buffer.from("abc").toString("base64");
    expect(
      policyView({ type: "image", data: tiny, mimeType: "image/png" }),
    ).toEqual({
      type: "image",
      data: `[binary image/png, 3 bytes, sha256 ${createHash("sha256").update("abc").digest("hex")}]`,
      mimeType: "image/png",
    });
  });

  test("accepts URL-safe and unpadded base64, which Gemini's JSON bytes allow", () => {
    const raw = Buffer.from([0xfb, 0xff, 0xfe, 0x01, 0x02]);
    const digest = createHash("sha256").update(raw).digest("hex");
    const expected = `[binary image/png, 5 bytes, sha256 ${digest}]`;
    for (const data of [
      raw.toString("base64"),
      raw.toString("base64url"),
      raw.toString("base64").replace(/=+$/, ""),
    ]) {
      expect(
        policyView({ inlineData: { mimeType: "image/png", data } }),
      ).toEqual({ inlineData: { mimeType: "image/png", data: expected } });
    }
  });

  test("shares one pass between callers that hold the same content object", () => {
    const content = [{ type: "image", data: b64, mimeType: "image/png" }];
    expect(policyView(content)).toBe(policyView(content));
  });
});

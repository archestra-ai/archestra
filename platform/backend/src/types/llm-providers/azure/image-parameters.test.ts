import { describe, expect, test } from "vitest";
import {
  ImageEditFieldsSchema,
  ImageGenerationRequestSchema,
} from "./image-parameters";

describe("Azure image generation SDK parameters", () => {
  test("preserves the SDK response format and style rather than stripping them", () => {
    const body = {
      model: "art-production",
      prompt: "A blue circle",
      response_format: "b64_json",
      style: "natural",
    };
    expect(ImageGenerationRequestSchema.parse(body)).toEqual(body);
  });

  test("preserves nullable and current SDK fields", () => {
    const body = {
      model: "art-production",
      prompt: "A blue circle",
      n: null,
      size: "1536x864",
      quality: "xhigh",
      safety_identifier: "synthetic-user",
      response_format: null,
      stream: null,
    };
    expect(ImageGenerationRequestSchema.parse(body)).toEqual(body);
  });

  test("parses multipart scalar fields without losing current SDK options", () => {
    expect(
      ImageEditFieldsSchema.parse({
        model: "art-production",
        prompt: "A blue circle",
        n: "2",
        output_compression: "80",
        size: "1536x864",
        quality: "max",
        safety_identifier: "synthetic-user",
        stream: "false",
      }),
    ).toMatchObject({ n: 2, output_compression: 80, stream: false });
  });

  test.each([
    true,
    "true",
    "0",
    0,
    "",
    [],
    {},
  ])("rejects ambiguous or unsupported multipart streaming %j", (stream) => {
    expect(
      ImageEditFieldsSchema.safeParse({
        model: "art-production",
        prompt: "A blue circle",
        stream,
      }).success,
    ).toBe(false);
  });

  test("rejects unsupported fields instead of silently dropping them", () => {
    expect(
      ImageGenerationRequestSchema.safeParse({
        model: "art-production",
        prompt: "A blue circle",
        partial_images: 1,
      }).success,
    ).toBe(false);
  });
});

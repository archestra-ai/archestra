import { describe, expect, test } from "vitest";
import { ResponsesRequestSchema } from "@/types/llm-providers/openai/api";
import { responsesToOpenaiChat } from "./openai-responses-translator";

function request(text: unknown) {
  // The public schema accepts unknown text; the translation validates it before
  // handing a request to the more narrowly typed provider SDK.
  return ResponsesRequestSchema.parse({
    model: "synthetic-model",
    input: "Reply OK.",
    text,
  }) as Parameters<typeof responsesToOpenaiChat>[0];
}

const schema = {
  type: "object",
  $defs: { status: { type: "string", enum: ["ready"] } },
  properties: { status: { $ref: "#/$defs/status" } },
  required: ["status"],
  additionalProperties: false,
};

describe("Responses output format translation", () => {
  test.for([
    "invalid",
    [],
    42,
  ])("rejects malformed text configuration %j", (text) => {
    expect(() => responsesToOpenaiChat(request(text))).toThrowError(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  test.each([
    false,
    null,
    undefined,
  ])("preserves optional strict value %s", (strict) => {
    const definition = {
      name: "status_result",
      schema,
      ...(strict === undefined ? {} : { strict }),
    };
    const input = request({ format: { type: "json_schema", ...definition } });
    expect(responsesToOpenaiChat(input).chatBody.response_format).toEqual({
      type: "json_schema",
      json_schema: definition,
    });
  });

  test.each([
    { type: "text" },
    { type: "json_object" },
    {
      type: "json_schema",
      name: "status_result",
      description: "Synthetic status",
      strict: true,
      schema,
    },
  ])("preserves $type output constraints on the Chat Completions wire", (format) => {
    const { chatBody } = responsesToOpenaiChat(request({ format }));
    expect(chatBody.response_format).toEqual(
      format.type === "json_schema"
        ? {
            type: "json_schema",
            json_schema: {
              name: "status_result",
              description: "Synthetic status",
              strict: true,
              schema,
            },
          }
        : format,
    );
  });

  test.for([
    null,
    [],
    "json",
    { type: "unsupported" },
    { type: "json_object", schema },
    { type: "json_schema", schema },
    { type: "json_schema", name: "status_result" },
    { type: "json_schema", name: "status_result", schema: [] },
    { type: "json_schema", name: "status_result", schema, strict: "true" },
    { type: "json_schema", name: "status_result", schema, description: 5 },
    {
      type: "json_schema",
      name: "status_result",
      schema,
      unsupported_option: true,
    },
  ])("rejects malformed or unsupported text.format %j", (format) => {
    expect(() => responsesToOpenaiChat(request({ format }))).toThrowError(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  test.each([
    {},
    { verbosity: "low" },
  ])("keeps the default text behavior without a format (%j)", (text) => {
    expect(responsesToOpenaiChat(request(text)).chatBody).not.toHaveProperty(
      "response_format",
    );
  });
});

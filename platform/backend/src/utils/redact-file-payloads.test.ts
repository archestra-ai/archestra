import { describe, expect, test } from "vitest";
import { redactFilePayloads } from "./redact-file-payloads";

describe("redactFilePayloads", () => {
  test("omits named legacy upload arguments across provider tool-call shapes, preserving unrelated arguments", () => {
    const argumentsObject = {
      filename: "report.pdf",
      content_base64: "private-file-body",
    };
    const name = "mcp__gateway__archestra__post_run_file";
    const input = [
      {
        type: "function",
        function: { name, arguments: JSON.stringify(argumentsObject) },
      },
      {
        type: "function_call",
        name,
        arguments: JSON.stringify(argumentsObject),
      },
      { type: "tool_use", name, input: argumentsObject },
      { functionCall: { name, args: argumentsObject } },
      { toolUse: { name, input: argumentsObject } },
      {
        type: "function",
        function: {
          name: "archestra__run_tool",
          arguments: JSON.stringify({
            tool_name: name,
            tool_args: argumentsObject,
          }),
        },
      },
    ];

    const result = JSON.stringify(redactFilePayloads(input));
    expect(result).not.toContain(argumentsObject.content_base64);
    expect(result).toContain("report.pdf");
    expect(JSON.stringify(input)).toContain(argumentsObject.content_base64);
    const unrelated = { name: "other_tool", arguments: argumentsObject };
    expect(redactFilePayloads(unrelated)).toEqual(unrelated);
    const unrelatedWrapped = {
      name: "archestra__run_tool",
      arguments: { tool_name: "other_tool", tool_args: argumentsObject },
    };
    expect(redactFilePayloads(unrelatedWrapped)).toEqual(unrelatedWrapped);
  });

  test("preserves arbitrary text, data and bytes fields instead of guessing file contents", () => {
    const input = {
      text: "data:image/png;base64,still ordinary message text",
      data: "private data",
      bytes: [1, 2, 3],
      source: { type: "base64", data: "not a file block" },
      content: [
        { type: "text", text: "extracted document text" },
        {
          type: "image",
          source: { type: "url", url: "https://example.com/a" },
        },
        {
          document: { source: { s3Location: { uri: "s3://example/report" } } },
        },
      ],
    };

    expect(redactFilePayloads(input)).toEqual(input);
  });

  test("redacts nested tool-result file bodies, including Bedrock byte arrays", () => {
    const input = {
      toolResult: {
        content: [
          {
            image: { format: "png", source: { bytes: Buffer.from("private") } },
          },
        ],
      },
    };
    const result = redactFilePayloads(input);

    expect(JSON.stringify(result)).not.toContain('"data"');
    expect(result.toolResult.content[0].image.source.bytes).toBe(
      "[Ephemeral file payload omitted]",
    );
    expect(input.toolResult.content[0].image.source.bytes).toEqual(
      Buffer.from("private"),
    );
  });

  test("removes MCP and UI file bodies from approval-history copies", () => {
    const body = Buffer.from("private file bytes").toString("base64");
    const input = {
      parts: [
        { type: "file", url: `data:application/pdf;base64,${body}` },
        {
          type: "tool-result",
          output: {
            content: [
              { type: "image", mimeType: "image/png", data: body },
              { type: "audio", mimeType: "audio/wav", data: body },
              {
                type: "resource",
                resource: { uri: "file:///report.pdf", blob: body },
              },
              { type: "text", text: "File captured" },
            ],
          },
        },
      ],
    };

    const result = JSON.stringify(redactFilePayloads(input));
    expect(result).not.toContain(body);
    expect(result).toContain("File captured");
    expect(result).toContain("file:///report.pdf");
    expect(JSON.stringify(input)).toContain(body);
  });
});

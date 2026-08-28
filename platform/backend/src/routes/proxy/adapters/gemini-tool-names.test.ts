import { describe, expect, test } from "@/test";
import type { Gemini } from "@/types";
import { GeminiToolNameCodec } from "./gemini-tool-names";

type GeminiRequest = Gemini.Types.GenerateContentRequest;

describe("GeminiToolNameCodec", () => {
  test("keeps names compatible, unique, and reversible", () => {
    const clientNames = [
      "valid_name",
      "server tool",
      "server@tool",
      `long_${"segment_".repeat(24)}`,
    ];
    const request = makeRequest(clientNames);
    const codec = new GeminiToolNameCodec(request);

    const encoded = codec.encodeRequest(request);
    const providerNames = declarations(encoded);

    expect(providerNames[0]).toBe(clientNames[0]);
    expect(providerNames).toHaveLength(clientNames.length);
    expect(new Set(providerNames).size).toBe(clientNames.length);
    for (const providerName of providerNames) {
      expect(providerName).toMatch(/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/);
    }

    const decoded = codec.decodeResponse({
      candidates: [
        {
          content: {
            role: "model",
            parts: providerNames.map((name) => ({
              functionCall: { name, args: {} },
            })),
          },
        },
      ],
    });
    const decodedNames = decoded.candidates?.[0].content?.parts?.map(
      (part) => part.functionCall?.name,
    );

    expect(decodedNames).toEqual(clientNames);
    expect(declarations(request)).toEqual(clientNames);
  });
});

function makeRequest(names: string[]): GeminiRequest {
  return {
    contents: [{ role: "user", parts: [{ text: "Use a tool" }] }],
    tools: [
      {
        functionDeclarations: names.map((name) => ({
          name,
          description: "A test tool",
          parameters: { type: "object" },
        })),
      },
    ],
  };
}

function declarations(request: GeminiRequest): string[] {
  const tools = Array.isArray(request.tools)
    ? request.tools
    : request.tools
      ? [request.tools]
      : [];
  return tools.flatMap(
    (tool) =>
      tool.functionDeclarations?.map((declaration) => declaration.name) ?? [],
  );
}

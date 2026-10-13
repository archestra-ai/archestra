import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { policyView } from "@/openappa/result-view";
import { azureResponsesAdapterFactory } from "./azure-responses";
import { bedrockAdapterFactory } from "./bedrock";
import { geminiAdapterFactory } from "./gemini";
import { openaiAdapterFactory } from "./openai";
import { openAiResponsesAdapterFactory } from "./openai-responses";

// A tool result that OpenAPPA keeps comes back as the JSON text of what the
// client sent. Each adapter must then forward the client's own parts, so an
// image stays an image, and must still replace the result when the approved
// output differs.

// Above OpenAPPA's old 64 KiB default, as a pasted screenshot is.
const DATA = Buffer.alloc(200_000, 7).toString("base64");
const WITHHELD = "[appa] withheld";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

describe("openai chat tool message", () => {
  const content = [
    { type: "text", text: "Read the file" },
    { type: "image_url", image_url: { url: `data:image/png;base64,${DATA}` } },
  ];
  const send = (update: string) => {
    const adapter = openaiAdapterFactory.createRequestAdapter({
      model: "gpt-4o",
      messages: [
        { role: "user", content: "look" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "Read", arguments: "{}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content },
      ],
    } as never);
    adapter.applyToolResultUpdates({ call_1: update });
    return JSON.stringify(adapter.toProviderRequest().messages);
  };

  test("keeps the image bytes when the result is kept as sent", () => {
    const sent = send(JSON.stringify(policyView(content)));
    expect(sent).toContain(DATA);
    // Not the JSON text of the parts, which would carry escaped quotes.
    expect(sent).not.toContain('\\"image_url\\"');
  });

  test("drops the image bytes when the output is replaced", () => {
    const sent = send(WITHHELD);
    expect(sent).toContain(WITHHELD);
    expect(sent).not.toContain(DATA.slice(0, 64));
  });
});

for (const [name, factory] of [
  ["openai responses", openAiResponsesAdapterFactory],
  ["azure responses", azureResponsesAdapterFactory],
] as const) {
  describe(`${name} function_call_output`, () => {
    const output = [
      { type: "input_text", text: "Read the file" },
      { type: "input_image", image_url: `data:image/png;base64,${DATA}` },
    ];
    const send = (update: string) => {
      const adapter = factory.createRequestAdapter({
        model: "gpt-4.1",
        input: [
          { role: "user", content: "look" },
          {
            type: "function_call",
            call_id: "call_1",
            name: "Read",
            arguments: "{}",
          },
          { type: "function_call_output", call_id: "call_1", output },
        ],
      } as never);
      adapter.applyToolResultUpdates({ call_1: update });
      const input = adapter.toProviderRequest().input as Array<{
        type?: string;
        output?: unknown;
      }>;
      return input.find((item) => item.type === "function_call_output")?.output;
    };

    test("keeps the parts, with the image byte-identical, when kept as sent", () => {
      const sent = send(JSON.stringify(policyView(output))) as typeof output;
      expect(sent).toEqual(output);
      expect(sha((sent[1] as { image_url: string }).image_url)).toBe(
        sha(`data:image/png;base64,${DATA}`),
      );
    });

    test("replaces them when the output differs", () => {
      expect(send(WITHHELD)).toBe(WITHHELD);
    });
  });
}

describe("bedrock toolResult", () => {
  const image = {
    image: { format: "png", source: { bytes: DATA } },
  };
  const send = (blocks: unknown[], update: string) => {
    const adapter = bedrockAdapterFactory.createRequestAdapter({
      modelId: "anthropic.claude-3-haiku",
      messages: [
        { role: "user", content: [{ text: "look" }] },
        {
          role: "assistant",
          content: [
            { toolUse: { toolUseId: "tu_1", name: "Read", input: {} } },
          ],
        },
        {
          role: "user",
          content: [{ toolResult: { toolUseId: "tu_1", content: blocks } }],
        },
      ],
    } as never);
    adapter.applyToolResultUpdates({ tu_1: update });
    const messages = adapter.toProviderRequest().messages as Array<{
      content: Array<{ toolResult?: { content: unknown } }>;
    }>;
    return messages[2].content[0].toolResult?.content;
  };

  test("keeps a single image block when it is kept as sent", () => {
    expect(send([image], JSON.stringify(policyView(image)))).toEqual([image]);
  });

  test("replaces it when the output differs", () => {
    expect(send([image], WITHHELD)).toEqual([{ text: WITHHELD }]);
  });

  test("never forwards blocks the runtime did not read", () => {
    const sent = send([{ text: "first" }, image], "first");
    expect(JSON.stringify(sent)).not.toContain(DATA.slice(0, 64));
  });
});

describe("gemini functionResponse", () => {
  const response = { content: [{ type: "text", text: "Read the file" }], DATA };
  const send = (update: string) => {
    const adapter = geminiAdapterFactory.createRequestAdapter({
      contents: [
        { role: "user", parts: [{ text: "look" }] },
        {
          role: "model",
          parts: [{ functionCall: { id: "fc_1", name: "Read", args: {} } }],
        },
        {
          role: "user",
          parts: [{ functionResponse: { id: "fc_1", name: "Read", response } }],
        },
      ],
    } as never);
    adapter.applyToolResultUpdates({ fc_1: update });
    return adapter.toProviderRequest().contents[2].parts?.[0] as {
      functionResponse: { response: Record<string, unknown> };
    };
  };

  test("keeps the response when it is kept as sent", () => {
    expect(
      send(JSON.stringify(policyView(response))).functionResponse.response,
    ).toEqual(response);
  });

  test("wraps the approved text when the output differs", () => {
    expect(send(WITHHELD).functionResponse.response).toEqual({
      sanitizedContent: WITHHELD,
    });
  });
});

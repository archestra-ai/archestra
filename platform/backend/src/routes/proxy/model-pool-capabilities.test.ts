import { beforeEach, describe, expect } from "vitest";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import LlmProviderApiKeyModelLinkModel from "@/models/llm-provider-api-key-model";
import ModelModel from "@/models/model";
import { test } from "@/test";
import { azureCapabilityConfigurationHash } from "@/utils/azure-capability-scope";
import { compatiblePoolMembers } from "./model-pool-capabilities";
import type { PoolWire } from "./model-pool-transport";

const members = ["small-text", "large-vision", "unknown"].map((modelId) => ({
  memberId: modelId,
  providerApiKeyId: "00000000-0000-4000-8000-000000000001",
  provider: "openai" as const,
  modelId,
  priority: 1,
  weight: 1,
}));
const compatible = (request: unknown, wire: PoolWire = "openai-chat") =>
  compatiblePoolMembers({ members, request, wire });

beforeEach(async () => {
  await ModelModel.create({
    provider: "openai",
    modelId: "small-text",
    externalId: "openai/small-text",
    outputModalities: ["text"],
    contextLength: 64,
    inputModalities: ["text"],
  });
  await ModelModel.create({
    provider: "openai",
    modelId: "large-vision",
    externalId: "openai/large-vision",
    outputModalities: ["text"],
    contextLength: 8192,
    inputModalities: ["text", "image", "audio", "video", "pdf"],
  });
});

describe("request compatibility", () => {
  test("keeps text-compatible and unknown members", async () => {
    expect(
      await compatible({ messages: [{ role: "user", content: "hi" }] }),
    ).toEqual(members);
  });
  test("Responses accounts for instructions, tool history and output reservations", async () => {
    expect(
      await compatible(
        { input: "Hi", max_output_tokens: 65 },
        "openai-responses",
      ),
    ).toEqual(members.slice(1));
    expect(
      await compatible(
        { instructions: "word ".repeat(100), input: "Hi" },
        "openai-responses",
      ),
    ).toEqual(members.slice(1));
    expect(
      await compatible(
        {
          input: [
            {
              type: "function_call_output",
              call_id: "call_1",
              output: "word ".repeat(100),
            },
          ],
        },
        "openai-responses",
      ),
    ).toEqual(members.slice(1));
  });
  test("Responses rejects account-local references without rejecting inline content or function schemas", async () => {
    for (const request of [
      { input: [{ type: "item_reference", id: "msg_stored" }] },
      ...["input_file", "input_image"].map((type) => ({
        input: [{ role: "user", content: [{ type, file_id: "file_stored" }] }],
      })),
      {
        input: [
          {
            type: "function_call_output",
            call_id: "call_1",
            output: [{ type: "input_file", file_id: "file_stored" }],
          },
        ],
      },
      { prompt: { id: "pmpt_stored" } },
      {
        input: [
          {
            type: "computer_call_output",
            call_id: "call_1",
            output: { type: "computer_screenshot", file_id: "file_stored" },
          },
        ],
      },
      {
        input: [{ type: "code_interpreter_call", container_id: "cntr_stored" }],
      },
      {
        input: [
          {
            type: "shell_call",
            environment: {
              type: "container_reference",
              container_id: "cntr_stored",
            },
          },
        ],
      },
      {
        tools: [
          {
            type: "image_generation",
            input_image_mask: { file_id: "file_stored" },
          },
        ],
      },
      {
        tools: [
          {
            type: "shell",
            environment: {
              type: "container_reference",
              container_id: "cntr_stored",
            },
          },
        ],
      },
      {
        tools: [
          {
            type: "shell",
            environment: { type: "container_auto", file_ids: ["file_stored"] },
          },
        ],
      },
      {
        tools: [
          {
            type: "shell",
            environment: {
              type: "container_auto",
              skills: [{ type: "skill_reference", skill_id: "skill_stored" }],
            },
          },
        ],
      },

      { tools: [{ type: "file_search", vector_store_ids: ["vs_stored"] }] },
      { tools: [{ type: "code_interpreter", container: "cntr_stored" }] },
      {
        tools: [
          {
            type: "code_interpreter",
            container: { type: "auto", file_ids: ["file_stored"] },
          },
        ],
      },
      {
        tools: [
          {
            type: "namespace",
            tools: [{ type: "file_search", vector_store_ids: ["vs_stored"] }],
          },
        ],
      },
    ]) {
      await expect(compatible(request, "openai-responses")).rejects.toThrow(
        "stored response, conversation, item, file, prompt, vector-store, container and skill references",
      );
    }
    await expect(
      compatible(
        {
          input: [
            {
              role: "user",
              content: [
                {
                  type: "input_file",
                  file_url: "https://example.test/file.pdf",
                },
              ],
            },
          ],
          tools: [
            {
              type: "image_generation",
              input_image_mask: { image_url: "https://example.test/mask.png" },
            },
            { type: "shell", environment: { type: "local" } },
            {
              type: "function",
              name: "lookup",
              parameters: {
                type: "object",
                properties: { file_id: { type: "string" } },
              },
            },
          ],
        },
        "openai-responses",
      ),
    ).resolves.toContainEqual(members[1]);
  });
  test.each([
    {
      wire: "openai-responses",
      modality: "image",
      body: {
        input: [
          {
            role: "user",
            content: [
              { type: "input_image", image_url: "data:image/png;base64,AA==" },
            ],
          },
        ],
      },
    },
    {
      wire: "openai-responses",
      modality: "pdf",
      body: {
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_file",
                filename: "fixture.pdf",
                file_data: "data:application/pdf;base64,AA==",
              },
            ],
          },
        ],
      },
    },
    {
      wire: "openai-chat",
      modality: "image",
      body: {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: "data:image/png;base64,AA==" },
              },
            ],
          },
        ],
      },
    },
    {
      wire: "anthropic",
      modality: "image",
      body: {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-1",
                content: [
                  {
                    type: "image",
                    source: {
                      type: "base64",
                      media_type: "image/png",
                      data: "AA==",
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    },
    {
      wire: "gemini",
      modality: "image",
      body: {
        contents: [
          {
            role: "user",
            parts: [{ inlineData: { mimeType: "image/png", data: "AA==" } }],
          },
        ],
      },
    },
    {
      wire: "gemini",
      modality: "pdf",
      body: {
        contents: [
          {
            role: "user",
            parts: [
              {
                file_data: {
                  mime_type: "application/pdf",
                  file_uri: "https://example.test/file",
                },
              },
            ],
          },
        ],
      },
    },
    {
      wire: "bedrock-converse",
      modality: "image",
      body: {
        messages: [
          {
            role: "user",
            content: [
              {
                toolResult: {
                  toolUseId: "t",
                  content: [
                    { image: { format: "png", source: { bytes: "AA==" } } },
                  ],
                },
              },
            ],
          },
        ],
      },
    },
    {
      wire: "openai-chat",
      modality: "audio",
      body: {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "input_audio",
                input_audio: { data: "AA==", format: "wav" },
              },
            ],
          },
        ],
      },
    },
    {
      wire: "gemini",
      modality: "video",
      body: {
        contents: [
          {
            role: "user",
            parts: [
              {
                fileData: {
                  mimeType: "video/mp4",
                  fileUri: "https://example.test/video",
                },
              },
            ],
          },
        ],
      },
    },
    {
      wire: "anthropic",
      modality: "pdf",
      body: {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: "AA==",
                },
              },
            ],
          },
        ],
      },
    },
  ] as const)("filters known input incompatibility on $wire", async ({
    wire,
    body,
    modality,
  }) => {
    const model = await ModelModel.findByProviderAndModelId(
      "openai",
      "large-vision",
    );
    if (!model) throw new Error("Missing model");
    await ModelModel.update(model.id, { inputModalities: ["text", modality] });
    expect(await compatible(body, wire)).toEqual(members.slice(1));
  });
  test.each([
    {
      wire: "openai-chat",
      body: {
        messages: [{ role: "system", content: "lengthy text ".repeat(100) }],
      },
    },
    {
      wire: "anthropic",
      body: {
        system: "lengthy text ".repeat(100),
        messages: [{ role: "user", content: "hi" }],
      },
    },
    {
      wire: "gemini",
      body: {
        systemInstruction: { parts: [{ text: "lengthy text ".repeat(100) }] },
      },
    },
    {
      wire: "bedrock-converse",
      body: { system: [{ text: "lengthy text ".repeat(100) }] },
    },
    {
      wire: "openai-chat",
      body: {
        messages: [
          {
            role: "assistant",
            tool_calls: [
              {
                type: "function",
                function: {
                  name: "test",
                  arguments: "lengthy text ".repeat(100),
                },
              },
            ],
          },
        ],
      },
    },
    {
      wire: "anthropic",
      body: {
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                name: "test",
                input: { value: "lengthy text ".repeat(100) },
              },
            ],
          },
        ],
      },
    },
    {
      wire: "openai-chat",
      body: {
        tools: [
          {
            type: "function",
            function: {
              name: "test",
              description: "lengthy text ".repeat(100),
            },
          },
        ],
      },
    },
    {
      wire: "bedrock-converse",
      body: {
        messages: [
          {
            role: "user",
            content: [
              {
                toolResult: {
                  content: [{ json: { result: "lengthy text ".repeat(100) } }],
                },
              },
            ],
          },
        ],
      },
    },
  ] as const)("counts system and tool context on $wire", async ({
    wire,
    body,
  }) => {
    expect(await compatible(body, wire)).toEqual(members.slice(1));
  });
  test("reserves requested output and respects custom context override", async () => {
    const body = {
      messages: [{ role: "user", content: "hi" }],
      max_completion_tokens: 65,
    };
    expect(await compatible(body)).toEqual(members.slice(1));
    const model = await ModelModel.findByProviderAndModelId(
      "openai",
      "small-text",
    );
    if (!model) throw new Error("Missing model");
    await ModelModel.update(model.id, { customContextLength: 128 });
    expect(await compatible(body)).toEqual(members);
  });
  test.each([
    {
      wire: "bedrock-converse",
      body: {
        messages: [
          {
            role: "user",
            content: [
              { guardContent: { text: { text: "lengthy text ".repeat(100) } } },
            ],
          },
        ],
      },
    },
    {
      wire: "gemini",
      body: {
        contents: [
          {
            parts: [
              {
                executableCode: {
                  language: "PYTHON",
                  code: "lengthy text ".repeat(100),
                },
              },
            ],
          },
        ],
      },
    },
    {
      wire: "gemini",
      body: {
        contents: [
          {
            parts: [
              {
                codeExecutionResult: {
                  outcome: "OUTCOME_OK",
                  output: "lengthy text ".repeat(100),
                },
              },
            ],
          },
        ],
      },
    },
  ] as const)("counts native guarded text and code on $wire", async ({
    wire,
    body,
  }) => {
    expect(await compatible(body, wire)).toEqual(members.slice(1));
  });
  test("uses Azure key-scoped evidence and keeps unknown or stale aliases eligible", async ({
    makeOrganization,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const keys = await Promise.all(
      ["text", "vision"].map((name) =>
        makeLlmProviderApiKey(org.id, null, {
          provider: "azure",
          baseUrl: `https://${name}.openai.azure.com/openai`,
        }),
      ),
    );
    const model = await ModelModel.create({
      provider: "azure",
      modelId: "alias",
      externalId: "azure/alias",
      contextLength: 1,
      inputModalities: ["text"],
      outputModalities: ["text"],
    });
    const azure = keys.map((key) => ({
      ...members[0],
      memberId: key.id,
      providerApiKeyId: key.id,
      provider: "azure" as const,
      modelId: "alias",
    }));
    const eligible = () =>
      compatiblePoolMembers({
        members: azure,
        wire: "openai-chat",
        request: {
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "hello world" },
                {
                  type: "image_url",
                  image_url: { url: "https://example.test/image.png" },
                },
              ],
            },
          ],
        },
      });
    // A globally shared alias cannot supply either key's context or modalities.
    expect(await eligible()).toEqual(azure);
    for (const [index, key] of keys.entries()) {
      await LlmProviderApiKeyModelLinkModel.syncModelsForApiKey(
        key.id,
        [
          {
            id: model.id,
            modelId: model.modelId,
            azureCapabilities: {
              kind: "text",
              source: "deployment",
              underlyingModelName: "gpt-4o",
              operations: ["chat"],
              inputModalities: index === 0 ? ["text"] : ["text", "image"],
              configurationHash: azureCapabilityConfigurationHash(key),
            },
          },
        ],
        "azure",
      );
    }
    expect(await eligible()).toEqual([azure[1]]);
    await LlmProviderApiKeyModel.update(keys[0].id, {
      extraHeaders: { "x-route": "changed" },
    });
    expect(await eligible()).toEqual(azure);
  });
  test("does not tokenize base64 or mistake structured tool JSON for media", async () => {
    expect(
      await compatible({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: {
                  url: `data:image/png;base64,${"A".repeat(100_000)}`,
                },
              },
            ],
          },
        ],
      }),
    ).toEqual(members.slice(1));
    expect(
      await compatible({
        messages: [
          {
            role: "assistant",
            tool_calls: [
              { function: { name: "test", arguments: '{"type":"image"}' } },
            ],
          },
        ],
      }),
    ).toEqual(members);
  });
});

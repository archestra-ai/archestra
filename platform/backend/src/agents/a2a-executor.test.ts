import { TOOL_LOAD_SKILL_FULL_NAME } from "@archestra/shared";
import { NoSuchToolError, type UIMessage } from "ai";
import { describe, vi } from "vitest";
import { MIN_IMAGE_ATTACHMENT_SIZE } from "@/agents/incoming-email/constants";
import ModelModel from "@/models/model";
import { expect, test } from "@/test";
import type { StageResult } from "./a2a/stage-attachments";
import {
  type A2AAttachment,
  buildUserContent,
  emitSubagentToolCalls,
  executeA2AMessage,
} from "./a2a-executor";
import { TOOL_DENIAL_INSTRUCTION } from "./agent-system-prompt";

const {
  mockStreamText,
  mockGetChatMcpTools,
  mockCreateLLMModelForAgent,
  mockResolveConversationLlmSelectionForAgent,
  mockBuildSkillCatalogPrompt,
} = vi.hoisted(() => ({
  mockStreamText: vi.fn(),
  mockGetChatMcpTools: vi.fn(),
  mockCreateLLMModelForAgent: vi.fn(),
  mockResolveConversationLlmSelectionForAgent: vi.fn(),
  mockBuildSkillCatalogPrompt: vi.fn(),
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    streamText: (...args: unknown[]) => mockStreamText(...args),
    stepCountIs: vi.fn(() => undefined),
  };
});

vi.mock("@/clients/chat-mcp-client", () => ({
  closeChatMcpClient: vi.fn(),
  getChatMcpTools: (...args: unknown[]) => mockGetChatMcpTools(...args),
}));

vi.mock("@/clients/llm-client", () => ({
  createLLMModelForAgent: (...args: unknown[]) =>
    mockCreateLLMModelForAgent(...args),
}));

vi.mock("@/utils/llm-resolution", async () => {
  const actual = await vi.importActual<typeof import("@/utils/llm-resolution")>(
    "@/utils/llm-resolution",
  );
  return {
    ...actual,
    resolveConversationLlmSelectionForAgent: (...args: unknown[]) =>
      mockResolveConversationLlmSelectionForAgent(...args),
  };
});

vi.mock("@/features/browser-stream/services/browser-stream.feature", () => ({
  browserStreamFeature: {
    isEnabled: vi.fn().mockReturnValue(false),
    closeTab: vi.fn(),
  },
}));

vi.mock("@/clients/mcp-client", () => ({
  default: {
    closeSession: vi.fn(),
  },
}));

vi.mock("@/skills/skill-catalog-prompt", () => ({
  buildSkillCatalogPrompt: (...args: unknown[]) =>
    mockBuildSkillCatalogPrompt(...args),
}));

// Base64 string large enough to pass the MIN_IMAGE_ATTACHMENT_SIZE (2KB) filter.
// 2732 base64 chars → ~2048 decoded bytes.
const VALID_IMAGE_BASE64 = "A".repeat(2732);

// runAgentStream probes `fullStream` before committing the attempt; yield a
// renderable event so a mocked streamText result commits on the first attempt.
function renderableFullStream(): AsyncIterable<{ type: string }> {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "text-delta" };
      yield { type: "finish", finishReason: "stop" };
    },
  };
}

describe("buildUserContent", () => {
  // gemini passes file parts through unchanged, so kept attachments surface as
  // `file` content parts with their original mediaType — the simplest provider
  // to assert which attachments survived.
  const geminiOpts = (ingestibleMimeTypes: Set<string>) => ({
    provider: "gemini" as const,
    anthropicNativeEndpoint: false,
    ingestibleMimeTypes,
  });
  const PDF_AND_IMAGES = new Set([
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/gif",
    "image/webp",
    "image/svg+xml",
  ]);

  // Returns the mediaTypes of all `file` content parts produced.
  function fileMediaTypes(content: unknown): string[] {
    if (!Array.isArray(content)) {
      return [];
    }
    return content
      .filter(
        (p): p is { type: "file"; mediaType: string } =>
          typeof p === "object" &&
          p !== null &&
          (p as { type?: unknown }).type === "file",
      )
      .map((p) => p.mediaType);
  }

  test("returns null content when no attachments are provided", async () => {
    const { content, note } = await buildUserContent(
      "Hello",
      undefined,
      geminiOpts(PDF_AND_IMAGES),
    );
    expect(content).toBeNull();
    expect(note).toBe("");
  });

  test("returns null content when attachments array is empty", async () => {
    const { content, note } = await buildUserContent(
      "Hello",
      [],
      geminiOpts(PDF_AND_IMAGES),
    );
    expect(content).toBeNull();
    expect(note).toBe("");
  });

  test("keeps a PDF when the model can read it", async () => {
    const attachments: A2AAttachment[] = [
      {
        contentType: "application/pdf",
        contentBase64: "JVBERi0xLjQ=",
        name: "doc.pdf",
      },
    ];

    const { content, note } = await buildUserContent(
      "Summarize this",
      attachments,
      geminiOpts(PDF_AND_IMAGES),
    );

    expect(fileMediaTypes(content)).toContain("application/pdf");
    expect(note).toBe("");
  });

  test("drops a non-image the model cannot read and names it in the note", async () => {
    const attachments: A2AAttachment[] = [
      {
        contentType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        contentBase64: "AAAA",
        name: "report.docx",
      },
    ];

    const { content, note } = await buildUserContent(
      "Read this",
      attachments,
      // Model reads PDFs/images but not docx.
      geminiOpts(PDF_AND_IMAGES),
    );

    expect(content).toBeNull();
    expect(note).toContain("report.docx");
  });

  test("keeps images regardless of the readable mime set, including image/jpg", async () => {
    const attachments: A2AAttachment[] = [
      {
        contentType: "image/png",
        contentBase64: VALID_IMAGE_BASE64,
        name: "a.png",
      },
      {
        // Non-standard mime that is NOT in the model-readable set; images must
        // still pass via the broad image/* check.
        contentType: "image/jpg",
        contentBase64: VALID_IMAGE_BASE64,
        name: "b.jpg",
      },
    ];

    const { content, note } = await buildUserContent(
      "Describe",
      attachments,
      // Deliberately omit image/jpg from the readable set.
      geminiOpts(new Set(["application/pdf"])),
    );

    const mediaTypes = fileMediaTypes(content);
    expect(mediaTypes).toContain("image/png");
    expect(mediaTypes).toContain("image/jpg");
    expect(note).toBe("");
  });

  test("keeps readable attachments and notes unreadable ones in a mixed set", async () => {
    const attachments: A2AAttachment[] = [
      {
        contentType: "application/pdf",
        contentBase64: "JVBERi0xLjQ=",
        name: "doc.pdf",
      },
      {
        contentType: "image/png",
        contentBase64: VALID_IMAGE_BASE64,
        name: "photo.png",
      },
      {
        contentType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        contentBase64: "AAAA",
        name: "report.docx",
      },
    ];

    const { content, note } = await buildUserContent(
      "Check this",
      attachments,
      geminiOpts(PDF_AND_IMAGES),
    );

    const mediaTypes = fileMediaTypes(content);
    expect(mediaTypes).toContain("application/pdf");
    expect(mediaTypes).toContain("image/png");
    expect(note).toContain("report.docx");
    // The note travels on the kept turn's text part too.
    const textPart = (content as { type: string; text?: string }[]).find(
      (p) => p.type === "text",
    );
    expect(textPart?.text).toContain("Check this");
    expect(textPart?.text).toContain("report.docx");
  });

  test("surfaces an unreadable attachment that has no filename", async () => {
    const attachments: A2AAttachment[] = [
      {
        contentType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        contentBase64: "AAAA",
      },
    ];

    const { note } = await buildUserContent(
      "Hello",
      attachments,
      geminiOpts(PDF_AND_IMAGES),
    );

    // No filename, but the unreadable attachment is still surfaced (not dropped).
    expect(note).not.toBe("");
  });

  test("defaults a missing content type instead of crashing the classifier", async () => {
    // An attachment can reach buildUserContent without a content type if an
    // upstream ingestion path's `as string` cast is ever exercised with an
    // undefined value. It must be normalized to a safe default rather than throw
    // on the `image/` prefix check (or produce a `data:undefined;...` URL).
    const attachments: A2AAttachment[] = [
      {
        contentType: undefined as unknown as string,
        contentBase64: "QUJD",
        name: "mystery.bin",
      },
    ];

    const { content } = await buildUserContent(
      "Inspect",
      attachments,
      // Make the defaulted octet-stream readable so the normalized attachment is
      // kept and its resolved mediaType is observable.
      geminiOpts(new Set(["application/octet-stream"])),
    );

    expect(fileMediaTypes(content)).toContain("application/octet-stream");
  });

  test("filters out tiny image attachments below MIN_IMAGE_ATTACHMENT_SIZE", async () => {
    // ~988 decoded bytes (below the 2KB threshold), like broken inline refs.
    const tinyBase64 = "A".repeat(1317);
    const validBase64 = "B".repeat(2732);

    const attachments: A2AAttachment[] = [
      {
        contentType: "image/png",
        contentBase64: tinyBase64,
        name: "broken-inline-ref.png",
      },
      {
        contentType: "image/jpeg",
        contentBase64: validBase64,
        name: "real-photo.jpg",
      },
    ];

    const { content, note } = await buildUserContent(
      "Check this",
      attachments,
      geminiOpts(PDF_AND_IMAGES),
    );

    expect(fileMediaTypes(content)).toEqual(["image/jpeg"]);
    expect(note).toContain("broken-inline-ref.png");
  });

  test("returns null content when all images are below minimum size", async () => {
    const attachments: A2AAttachment[] = [
      {
        contentType: "image/png",
        contentBase64: "A".repeat(100), // ~75 bytes
        name: "tiny.png",
      },
    ];

    const { content, note } = await buildUserContent(
      "Hello",
      attachments,
      geminiOpts(PDF_AND_IMAGES),
    );

    expect(content).toBeNull();
    expect(note).toContain("tiny.png");
  });

  test("does not filter images at or above the minimum size threshold", async () => {
    // 2048 bytes = MIN_IMAGE_ATTACHMENT_SIZE → base64 length 2731 chars.
    const thresholdBase64 = "C".repeat(2731);
    expect(Math.ceil((2731 * 3) / 4)).toBeGreaterThanOrEqual(
      MIN_IMAGE_ATTACHMENT_SIZE,
    );

    const attachments: A2AAttachment[] = [
      {
        contentType: "image/png",
        contentBase64: thresholdBase64,
        name: "threshold.png",
      },
    ];

    const { content } = await buildUserContent(
      "Test",
      attachments,
      geminiOpts(PDF_AND_IMAGES),
    );

    expect(fileMediaTypes(content)).toEqual(["image/png"]);
  });

  // Concatenated text of all `text` content parts (gemini decode-and-inlines
  // text documents, so an inlined doc's bytes land here rather than as a file).
  function allText(content: unknown): string {
    if (!Array.isArray(content)) {
      return "";
    }
    return content
      .filter(
        (p): p is { type: "text"; text: string } =>
          typeof p === "object" &&
          p !== null &&
          (p as { type?: unknown }).type === "text",
      )
      .map((p) => p.text)
      .join("");
  }

  function recordingStager(results: StageResult[]) {
    const calls: A2AAttachment[][] = [];
    return {
      calls,
      fn: async (atts: A2AAttachment[]): Promise<StageResult[]> => {
        calls.push(atts);
        return results;
      },
    };
  }

  test("inlines a small inlineable text type the model does not list as readable", async () => {
    // yaml is not in the readable mime set, but it is inlineable text ≤ 256KB.
    const attachments: A2AAttachment[] = [
      {
        contentType: "application/x-yaml",
        contentBase64: Buffer.from("key: value").toString("base64"),
        name: "config.yaml",
      },
    ];

    const { content, note } = await buildUserContent(
      "Read this",
      attachments,
      geminiOpts(PDF_AND_IMAGES),
    );

    expect(content).not.toBeNull();
    expect(note).toBe("");
    // gemini inlines the decoded text, so the file content reaches the model.
    expect(allText(content)).toContain("key: value");
  });

  test("stages a non-readable binary into the sandbox when one is available", async () => {
    const attachments: A2AAttachment[] = [
      {
        contentType: "application/octet-stream",
        contentBase64: Buffer.from("sqlite-bytes").toString("base64"),
        name: "repair.sqlite",
      },
    ];
    const stager = recordingStager([
      { path: "/home/sandbox/attachments/repair.sqlite" },
    ]);

    const { content, note } = await buildUserContent(
      "Inspect this",
      attachments,
      {
        ...geminiOpts(PDF_AND_IMAGES),
        stageAttachments: stager.fn,
      },
    );

    expect(stager.calls).toHaveLength(1);
    expect(stager.calls[0][0].name).toBe("repair.sqlite");
    expect(content).toBeNull();
    expect(note).toContain("/home/sandbox/attachments/repair.sqlite");
  });

  test("names a non-readable binary in the note when no sandbox is available", async () => {
    const attachments: A2AAttachment[] = [
      {
        contentType: "application/octet-stream",
        contentBase64: Buffer.from("sqlite-bytes").toString("base64"),
        name: "repair.sqlite",
      },
    ];

    const { content, note } = await buildUserContent(
      "Inspect this",
      attachments,
      geminiOpts(PDF_AND_IMAGES),
    );

    expect(content).toBeNull();
    expect(note).toContain("repair.sqlite");
  });

  test("routes oversized inlineable text to the sandbox instead of inlining it", async () => {
    // ~262KB of decoded bytes, over the 256KB inline cap.
    const bigText = "A".repeat(349528);
    const attachments: A2AAttachment[] = [
      { contentType: "text/csv", contentBase64: bigText, name: "big.csv" },
    ];
    const stager = recordingStager([
      { path: "/home/sandbox/attachments/big.csv" },
    ]);

    const { content, note } = await buildUserContent("Analyze", attachments, {
      ...geminiOpts(new Set(["text/csv"])),
      stageAttachments: stager.fn,
    });

    expect(stager.calls).toHaveLength(1);
    expect(content).toBeNull();
    expect(note).toContain("/home/sandbox/attachments/big.csv");
  });

  test("skips oversized inlineable text when no sandbox is available", async () => {
    const bigText = "A".repeat(349528);
    const attachments: A2AAttachment[] = [
      { contentType: "text/csv", contentBase64: bigText, name: "big.csv" },
    ];

    const { content, note } = await buildUserContent(
      "Analyze",
      attachments,
      geminiOpts(new Set(["text/csv"])),
    );

    expect(content).toBeNull();
    expect(note).toContain("big.csv");
  });

  test("does not attempt to stage a file larger than the sandbox limit", async () => {
    const attachments: A2AAttachment[] = [
      {
        contentType: "application/octet-stream",
        contentBase64: Buffer.from("0123456789abcdef").toString("base64"),
        name: "big.bin",
      },
    ];
    const stager = recordingStager([]);

    const { content, note } = await buildUserContent("Inspect", attachments, {
      ...geminiOpts(PDF_AND_IMAGES),
      sandboxByteLimit: 4,
      stageAttachments: stager.fn,
    });

    expect(stager.calls).toHaveLength(0);
    expect(content).toBeNull();
    expect(note).toContain("big.bin");
  });

  test("surfaces a staging failure in the note rather than dropping it silently", async () => {
    const attachments: A2AAttachment[] = [
      {
        contentType: "application/octet-stream",
        contentBase64: Buffer.from("sqlite-bytes").toString("base64"),
        name: "repair.sqlite",
      },
    ];
    const stager = recordingStager([{ error: true }]);

    const { content, note } = await buildUserContent("Inspect", attachments, {
      ...geminiOpts(PDF_AND_IMAGES),
      stageAttachments: stager.fn,
    });

    expect(stager.calls).toHaveLength(1);
    expect(content).toBeNull();
    // The file is named (not silently dropped) but carries no sandbox pointer.
    expect(note).toContain("repair.sqlite");
    expect(note).not.toContain("/home/sandbox");
  });
});

describe("executeA2AMessage current turn assembly", () => {
  function primeStreamMocks() {
    mockGetChatMcpTools.mockResolvedValue({});
    mockResolveConversationLlmSelectionForAgent.mockResolvedValue({
      chatApiKeyId: "org-key",
      selectedModel: "claude-sonnet-4-6",
      selectedProvider: "anthropic",
    });
    mockCreateLLMModelForAgent.mockResolvedValue({
      model: { provider: "mock" },
      provider: "anthropic",
      apiKeySource: "org",
      anthropicNativeEndpoint: true,
    });
    mockStreamText.mockReturnValue({
      toUIMessageStream: vi.fn((options) => {
        const responseMessage = {
          id: "msg-1",
          role: "assistant",
          parts: [{ type: "text", text: "ok" }],
        };
        options?.onFinish?.({
          messages: [responseMessage],
          isContinuation: false,
          isAborted: false,
          responseMessage,
          finishReason: "stop",
        });
        return new ReadableStream({
          start(controller) {
            controller.close();
          },
        });
      }),
      fullStream: renderableFullStream(),
      text: Promise.resolve("ok"),
      usage: Promise.resolve(undefined),
      finishReason: Promise.resolve("stop"),
    });
  }

  test("appends exactly one current user turn to the provided history", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
      systemPrompt: "Handle the task.",
    });
    primeStreamMocks();

    const history = [
      { role: "user" as const, content: "prior question" },
      { role: "assistant" as const, content: "earlier reply" },
    ];
    await executeA2AMessage({
      agentId: agent.id,
      message: "current question",
      messages: history,
      organizationId: org.id,
      userId: "user-1",
      conversationId: "conv-1",
    });

    const config = mockStreamText.mock.calls[0]?.[0];
    expect(config.messages).toHaveLength(history.length + 1);
    expect(config.messages.at(-1)).toEqual({
      role: "user",
      content: "current question",
    });
  });

  test("uses history as-is when the current turn has no text or attachments", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
      systemPrompt: "Handle the task.",
    });
    primeStreamMocks();

    const history = [{ role: "user" as const, content: "prior question" }];
    await executeA2AMessage({
      agentId: agent.id,
      message: "",
      messages: history,
      organizationId: org.id,
      userId: "user-1",
      conversationId: "conv-1",
    });

    const config = mockStreamText.mock.calls[0]?.[0];
    expect(config.messages).toEqual(history);
  });

  test("caps output tokens at the model's real ceiling, clamped by the operator ceiling", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
      systemPrompt: "Handle the task.",
    });
    await ModelModel.upsert({
      externalId: "anthropic/claude-sonnet-4-6",
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      description: "Claude Sonnet 4.6",
      contextLength: 200000,
      outputLength: 64000,
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsToolCalling: true,
      promptPricePerToken: null,
      completionPricePerToken: null,
      lastSyncedAt: new Date(),
    });
    primeStreamMocks();

    await executeA2AMessage({
      agentId: agent.id,
      message: "current question",
      organizationId: org.id,
      userId: "user-1",
      conversationId: "conv-1",
    });

    const config = mockStreamText.mock.calls[0]?.[0];
    expect(config.maxOutputTokens).toBe(32768);
  });

  test("falls back to the unknown-model output budget when no model row exists", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
      systemPrompt: "Handle the task.",
    });
    primeStreamMocks();

    await executeA2AMessage({
      agentId: agent.id,
      message: "current question",
      organizationId: org.id,
      userId: "user-1",
      conversationId: "conv-1",
    });

    const config = mockStreamText.mock.calls[0]?.[0];
    expect(config.maxOutputTokens).toBe(8192);
  });
});

describe("executeA2AMessage model selection", () => {
  test("uses the shared conversation selection so delegated agents inherit the organization default model", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
      systemPrompt: "Handle the task.",
    });

    mockResolveConversationLlmSelectionForAgent.mockResolvedValue({
      chatApiKeyId: "org-key",
      selectedModel: "gemini-2.5-pro",
      selectedProvider: "gemini",
    });
    mockGetChatMcpTools.mockResolvedValue({});
    mockCreateLLMModelForAgent.mockResolvedValue({
      model: { provider: "mock" },
      provider: "gemini",
      apiKeySource: "org",
    });
    mockStreamText.mockReturnValue({
      toUIMessageStream: vi.fn((options) => {
        const responseMessage = {
          id: "msg-1",
          role: "assistant",
          parts: [{ type: "text", text: "Delegated response" }],
        };

        options?.onFinish?.({
          messages: [responseMessage],
          isContinuation: false,
          isAborted: false,
          responseMessage,
          finishReason: "stop",
        });

        return new ReadableStream({
          start(controller) {
            controller.close();
          },
        });
      }),
      fullStream: renderableFullStream(),
      text: Promise.resolve("Delegated response"),
      usage: Promise.resolve(undefined),
      finishReason: Promise.resolve("stop"),
    });

    await executeA2AMessage({
      agentId: agent.id,
      message: "Handle this",
      organizationId: org.id,
      userId: user.id,
      conversationId: "conv-1",
      parentDelegationChain: "agent-parent",
    });

    expect(mockResolveConversationLlmSelectionForAgent).toHaveBeenCalledWith({
      agent: {
        llmApiKeyId: null,
        modelId: null,
      },
      organizationId: org.id,
      userId: user.id,
      // A2A runs never adopt the acting member's /chat default.
      includeMemberChatDefault: false,
    });
    expect(mockCreateLLMModelForAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: org.id,
        userId: user.id,
        agentId: agent.id,
        model: "gemini-2.5-pro",
        provider: "gemini",
        externalAgentId: `agent-parent:${agent.id}`,
      }),
    );
  });
});

describe("executeA2AMessage isolation scope", () => {
  function primeExecutionMocks() {
    mockGetChatMcpTools.mockClear();
    mockResolveConversationLlmSelectionForAgent.mockResolvedValue({
      chatApiKeyId: "org-key",
      selectedModel: "gemini-2.5-pro",
      selectedProvider: "gemini",
    });
    mockGetChatMcpTools.mockResolvedValue({});
    mockCreateLLMModelForAgent.mockResolvedValue({
      model: { provider: "mock" },
      provider: "gemini",
      apiKeySource: "org",
    });
    mockStreamText.mockReturnValue({
      toUIMessageStream: vi.fn((options) => {
        const responseMessage = {
          id: "msg-1",
          role: "assistant",
          parts: [{ type: "text", text: "ok" }],
        };
        options?.onFinish?.({
          messages: [responseMessage],
          isContinuation: false,
          isAborted: false,
          responseMessage,
          finishReason: "stop",
        });
        return new ReadableStream({
          start(controller) {
            controller.close();
          },
        });
      }),
      fullStream: renderableFullStream(),
      text: Promise.resolve("ok"),
      usage: Promise.resolve(undefined),
      finishReason: Promise.resolve("stop"),
    });
  }

  function toolWiring(): { conversationId?: string; isolationKey?: string } {
    return mockGetChatMcpTools.mock.calls[0][0] as {
      conversationId?: string;
      isolationKey?: string;
    };
  }

  test("headless executions never fabricate a conversation id for tools", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
      systemPrompt: "Handle the task.",
    });
    primeExecutionMocks();
    await executeA2AMessage({
      agentId: agent.id,
      message: "Handle this",
      organizationId: org.id,
      userId: "user-1",
    });

    const wiring = toolWiring();
    // tools may persist conversationId as a foreign key, so it must stay
    // absent; the generated execution key travels only as isolationKey.
    expect(wiring.conversationId).toBeUndefined();
    expect(wiring.isolationKey).toEqual(expect.any(String));
  });

  test("chat-delegated executions scope isolation by the real conversation id", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
      systemPrompt: "Handle the task.",
    });
    primeExecutionMocks();
    await executeA2AMessage({
      agentId: agent.id,
      message: "Handle this",
      organizationId: org.id,
      userId: "user-1",
      conversationId: "conv-1",
    });

    const wiring = toolWiring();
    expect(wiring.conversationId).toBe("conv-1");
    expect(wiring.isolationKey).toBe("conv-1");
  });

  test("headless delegation inherits the parent's isolation key", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
      systemPrompt: "Handle the task.",
    });
    primeExecutionMocks();
    await executeA2AMessage({
      agentId: agent.id,
      message: "Handle this",
      organizationId: org.id,
      userId: "user-1",
      isolationKey: "parent-execution-key",
    });

    const wiring = toolWiring();
    expect(wiring.conversationId).toBeUndefined();
    expect(wiring.isolationKey).toBe("parent-execution-key");
  });
});

describe("executeA2AMessage unavailable tool errors", () => {
  test("recovers unavailable-tool stream errors instead of failing the run", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
      systemPrompt: "Handle the task.",
    });

    mockResolveConversationLlmSelectionForAgent.mockResolvedValue({
      chatApiKeyId: "org-key",
      selectedModel: "claude-sonnet-4-6",
      selectedProvider: "anthropic",
    });
    mockGetChatMcpTools.mockResolvedValue({});
    mockCreateLLMModelForAgent.mockResolvedValue({
      model: { provider: "mock" },
      provider: "anthropic",
      apiKeySource: "org",
    });

    let capturedOnError: ((error: unknown) => string) | undefined;
    mockStreamText.mockReturnValue({
      toUIMessageStream: vi.fn((options) => {
        capturedOnError = options?.onError;
        const responseMessage = {
          id: "msg-1",
          role: "assistant",
          parts: [{ type: "text", text: "Recovered response" }],
        };

        options?.onFinish?.({
          messages: [responseMessage],
          isContinuation: false,
          isAborted: false,
          responseMessage,
          finishReason: "stop",
        });

        return new ReadableStream({
          start(controller) {
            controller.close();
          },
        });
      }),
      fullStream: renderableFullStream(),
      text: Promise.resolve("Recovered response"),
      usage: Promise.resolve(undefined),
      finishReason: Promise.resolve("stop"),
    });

    await executeA2AMessage({
      agentId: agent.id,
      message: "Handle this",
      organizationId: org.id,
      userId: "user-1",
      conversationId: "conv-1",
    });

    expect(capturedOnError).toBeDefined();

    const fromInstance = capturedOnError?.(
      new NoSuchToolError({
        toolName: "ghost_tool",
        availableTools: ["real_tool"],
      }),
    );
    expect(fromInstance).toContain(
      "The requested tool is not available in this chat.",
    );
    expect(fromInstance).toContain('"requestedToolName": "ghost_tool"');

    // the SDK's duplicate tool-error part arrives pre-stringified; it must be
    // recognized the same way, not escalated into a failed run
    const fromString = capturedOnError?.(
      "Model tried to call unavailable tool 'ghost_tool'. Available tools: real_tool.",
    );
    expect(fromString).toBe(fromInstance);

    // unrelated stream errors keep failing the run
    expect(() => capturedOnError?.(new Error("boom"))).toThrow("boom");
  });
});

describe("executeA2AMessage skill catalog", () => {
  function primeMocks(tools: Record<string, unknown>) {
    mockStreamText.mockClear();
    mockBuildSkillCatalogPrompt.mockClear();
    mockResolveConversationLlmSelectionForAgent.mockResolvedValue({
      chatApiKeyId: "org-key",
      selectedModel: "gemini-2.5-pro",
      selectedProvider: "gemini",
    });
    mockCreateLLMModelForAgent.mockResolvedValue({
      model: { provider: "mock" },
      provider: "gemini",
      apiKeySource: "org",
    });
    mockGetChatMcpTools.mockResolvedValue(tools);
    mockStreamText.mockReturnValue({
      toUIMessageStream: vi.fn((options) => {
        const responseMessage = {
          id: "msg-1",
          role: "assistant",
          parts: [{ type: "text", text: "done" }],
        };
        options?.onFinish?.({
          messages: [responseMessage],
          isContinuation: false,
          isAborted: false,
          responseMessage,
          finishReason: "stop",
        });
        return new ReadableStream({
          start(controller) {
            controller.close();
          },
        });
      }),
      fullStream: renderableFullStream(),
      text: Promise.resolve("done"),
      usage: Promise.resolve(undefined),
      finishReason: Promise.resolve("stop"),
    });
  }

  test("appends the skill catalog to the system prompt when the agent can load skills", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
      systemPrompt: "Handle the task.",
    });
    primeMocks({
      [TOOL_LOAD_SKILL_FULL_NAME]: { description: "Load" },
    });
    mockBuildSkillCatalogPrompt.mockResolvedValue(
      '<available_skills>\n<skill name="pdf">x</skill>\n</available_skills>',
    );

    await executeA2AMessage({
      agentId: agent.id,
      message: "do it",
      organizationId: org.id,
      userId: "user-1",
      conversationId: "conv-1",
    });

    expect(mockBuildSkillCatalogPrompt).toHaveBeenCalledWith({
      organizationId: org.id,
      userId: "user-1",
      agentId: agent.id,
    });
    const system = mockStreamText.mock.calls[0]?.[0].system;
    expect(system).toContain("Handle the task.");
    expect(system).toContain("<available_skills>");
  });

  test("omits the skill catalog but keeps the shared tool instructions when no skill tools are available", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
      systemPrompt: "Handle the task.",
    });
    primeMocks({});
    mockBuildSkillCatalogPrompt.mockResolvedValue("<available_skills>...");

    await executeA2AMessage({
      agentId: agent.id,
      message: "do it",
      organizationId: org.id,
      userId: "user-1",
      conversationId: "conv-1",
    });

    expect(mockBuildSkillCatalogPrompt).not.toHaveBeenCalled();
    const system = mockStreamText.mock.calls[0]?.[0].system;
    expect(system).toContain("Handle the task.");
    expect(system).not.toContain("<available_skills>");
    expect(system).toContain(TOOL_DENIAL_INSTRUCTION);
  });
});

describe("emitSubagentToolCalls", () => {
  type Emitted = {
    parentToolCallId: string;
    toolCallId: string;
    toolName: string;
    input?: unknown;
    output?: unknown;
    state?: string;
    errorText?: string;
  };
  const fakeBridge = () => {
    const emitted: Emitted[] = [];
    return {
      bridge: {
        setWriter: () => {},
        emit: (d: Emitted) => emitted.push(d),
        collected: () => [],
      },
      emitted,
    };
  };

  test("emits one call per tool part, attributed to the delegation call", () => {
    const { bridge, emitted } = fakeBridge();
    emitSubagentToolCalls({
      bridge,
      parentToolCallId: "P1",
      message: {
        id: "m",
        role: "assistant",
        parts: [
          { type: "text", text: "thinking" },
          {
            type: "tool-web_search",
            toolCallId: "C1",
            state: "output-available",
            input: { q: "x" },
            output: { hits: 1 },
          },
          {
            type: "dynamic-tool",
            toolName: "fetch",
            toolCallId: "C2",
            state: "output-error",
            errorText: "boom",
          },
        ],
      } as unknown as UIMessage,
    });

    expect(emitted).toHaveLength(2);
    expect(emitted[0]).toMatchObject({
      parentToolCallId: "P1",
      toolCallId: "C1",
      toolName: "web_search",
      input: { q: "x" },
      output: { hits: 1 },
    });
    expect(emitted[1]).toMatchObject({
      parentToolCallId: "P1",
      toolCallId: "C2",
      toolName: "fetch",
      errorText: "boom",
    });
  });

  test("a nested delegation call surfaces as a tool part (its children come from its own run)", () => {
    const { bridge, emitted } = fakeBridge();
    emitSubagentToolCalls({
      bridge,
      parentToolCallId: "P1",
      message: {
        id: "m",
        role: "assistant",
        parts: [
          {
            type: "tool-agent__grandchild",
            toolCallId: "C2",
            state: "output-available",
            input: { message: "do" },
          },
        ],
      } as unknown as UIMessage,
    });
    expect(emitted).toEqual([
      {
        parentToolCallId: "P1",
        toolCallId: "C2",
        toolName: "agent__grandchild",
        input: { message: "do" },
        state: "output-available",
      },
    ]);
  });

  test("skips parts that are not tool calls", () => {
    const { bridge, emitted } = fakeBridge();
    emitSubagentToolCalls({
      bridge,
      parentToolCallId: "P1",
      message: {
        id: "m",
        role: "assistant",
        parts: [
          { type: "text", text: "hi" },
          { type: "reasoning", text: "hmm" },
          { type: "step-start" },
        ],
      } as unknown as UIMessage,
    });
    expect(emitted).toHaveLength(0);
  });

  test("collapses input-available then output-available for the same id (last wins)", () => {
    const { bridge, emitted } = fakeBridge();
    emitSubagentToolCalls({
      bridge,
      parentToolCallId: "P1",
      message: {
        id: "m",
        role: "assistant",
        parts: [
          {
            type: "tool-web_search",
            toolCallId: "C1",
            state: "input-available",
            input: { q: "x" },
          },
          {
            type: "tool-web_search",
            toolCallId: "C1",
            state: "output-available",
            input: { q: "x" },
            output: { hits: 1 },
          },
        ],
      } as unknown as UIMessage,
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      toolCallId: "C1",
      state: "output-available",
      output: { hits: 1 },
    });
  });

  test("falls back to 'unknown' for a dynamic-tool part with no toolName", () => {
    const { bridge, emitted } = fakeBridge();
    emitSubagentToolCalls({
      bridge,
      parentToolCallId: "P1",
      message: {
        id: "m",
        role: "assistant",
        parts: [
          { type: "dynamic-tool", toolCallId: "C1", state: "output-available" },
        ],
      } as unknown as UIMessage,
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0].toolName).toBe("unknown");
  });

  test("skips a tool part that has no toolCallId", () => {
    const { bridge, emitted } = fakeBridge();
    emitSubagentToolCalls({
      bridge,
      parentToolCallId: "P1",
      message: {
        id: "m",
        role: "assistant",
        parts: [{ type: "tool-web_search", state: "output-available" }],
      } as unknown as UIMessage,
    });
    expect(emitted).toHaveLength(0);
  });

  test("emits nothing for a message with no parts", () => {
    const { bridge, emitted } = fakeBridge();
    emitSubagentToolCalls({
      bridge,
      parentToolCallId: "P1",
      message: { id: "m", role: "assistant" } as unknown as UIMessage,
    });
    expect(emitted).toHaveLength(0);
  });
});

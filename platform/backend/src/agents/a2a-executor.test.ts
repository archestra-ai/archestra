import { describe, expect, test, vi } from "vitest";
import { MIN_IMAGE_ATTACHMENT_SIZE } from "@/agents/incoming-email/constants";
import {
  type A2AAttachment,
  buildUserContent,
  executeA2AMessage,
} from "./a2a-executor";

const {
  mockStreamText,
  mockGetChatMcpTools,
  mockCreateLLMModelForAgent,
  mockResolveConversationLlmSelectionForAgent,
} = vi.hoisted(() => ({
  mockStreamText: vi.fn(),
  mockGetChatMcpTools: vi.fn(),
  mockCreateLLMModelForAgent: vi.fn(),
  mockResolveConversationLlmSelectionForAgent: vi.fn(),
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

vi.mock("@/models", async () => {
  const actual = await vi.importActual<typeof import("@/models")>("@/models");
  return {
    ...actual,
    AgentModel: {
      findById: vi.fn(),
    },
    McpServerModel: {
      getUserPersonalServerForCatalog: vi.fn(),
    },
    TeamModel: {
      getUserTeams: vi.fn(),
    },
    UserModel: {
      getById: vi.fn(),
    },
  };
});

vi.mock("@/templating", async () => {
  const actual =
    await vi.importActual<typeof import("@/templating")>("@/templating");
  return {
    ...actual,
    promptNeedsRendering: vi.fn(() => false),
    renderSystemPrompt: vi.fn((prompt: string) => prompt),
  };
});

import { AgentModel, McpServerModel } from "@/models";

// Base64 string large enough to pass the MIN_IMAGE_ATTACHMENT_SIZE (2KB) filter.
// 2732 base64 chars → ~2048 decoded bytes.
const VALID_IMAGE_BASE64 = "A".repeat(2732);

describe("buildUserContent", () => {
  test("returns null content when no attachments are provided", () => {
    const { content, skippedNote } = buildUserContent("Hello");
    expect(content).toBeNull();
    expect(skippedNote).toBe("");
  });

  test("returns null content when attachments array is empty", () => {
    const { content, skippedNote } = buildUserContent("Hello", []);
    expect(content).toBeNull();
    expect(skippedNote).toBe("");
  });

  test("returns null content with skipped note when attachments contain no images", () => {
    const attachments: A2AAttachment[] = [
      {
        contentType: "application/pdf",
        contentBase64: "JVBERi0xLjQ=",
        name: "doc.pdf",
      },
      {
        contentType: "text/plain",
        contentBase64: "SGVsbG8=",
        name: "note.txt",
      },
    ];

    const { content, skippedNote } = buildUserContent("Hello", attachments);

    expect(content).toBeNull();
    expect(skippedNote).toContain("2 attachment(s)");
    expect(skippedNote).toContain("doc.pdf");
    expect(skippedNote).toContain("note.txt");
  });

  test("builds content parts with a single image attachment", () => {
    const attachments: A2AAttachment[] = [
      {
        contentType: "image/png",
        contentBase64: VALID_IMAGE_BASE64,
        name: "photo.png",
      },
    ];

    const { content } = buildUserContent("Describe this image", attachments);

    expect(content).toHaveLength(2);
    expect(content?.[0]).toEqual({ type: "text", text: "Describe this image" });
    expect(content?.[1]).toHaveProperty("type", "file");
    expect(content?.[1]).toHaveProperty("mediaType", "image/png");
    expect(content?.[1]).toHaveProperty("data");
    // Verify the data is a Buffer with the correct decoded bytes
    const filePart = content?.[1] as { data: Buffer; mediaType: string };
    expect(Buffer.isBuffer(filePart.data)).toBe(true);
    expect(filePart.data.toString("base64")).toBe(VALID_IMAGE_BASE64);
  });

  test("builds content parts with multiple image attachments", () => {
    const pngBase64 = "B".repeat(3000);
    const jpegBase64 = "C".repeat(3000);
    const attachments: A2AAttachment[] = [
      {
        contentType: "image/png",
        contentBase64: pngBase64,
        name: "image1.png",
      },
      {
        contentType: "image/jpeg",
        contentBase64: jpegBase64,
        name: "image2.jpg",
      },
    ];

    const { content } = buildUserContent(
      "What's in these photos?",
      attachments,
    );

    expect(content).toHaveLength(3); // 1 text + 2 files
    expect(content?.[0]).toEqual({
      type: "text",
      text: "What's in these photos?",
    });
    expect(content?.[1]).toHaveProperty("type", "file");
    expect(content?.[1]).toHaveProperty("mediaType", "image/png");
    expect(content?.[2]).toHaveProperty("type", "file");
    expect(content?.[2]).toHaveProperty("mediaType", "image/jpeg");
  });

  test("filters out non-image attachments from mixed set and appends note", () => {
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
        contentType: "text/plain",
        contentBase64: "SGVsbG8=",
        name: "note.txt",
      },
    ];

    const { content, skippedNote } = buildUserContent(
      "Check this",
      attachments,
    );

    expect(content).toHaveLength(2); // 1 text + 1 file
    expect(content?.[0]).toHaveProperty("type", "text");
    // The text part should include the skipped note
    expect((content?.[0] as { text: string }).text).toContain("Check this");
    expect((content?.[0] as { text: string }).text).toContain(
      "2 attachment(s)",
    );
    expect(content?.[1]).toHaveProperty("type", "file");
    expect(content?.[1]).toHaveProperty("mediaType", "image/png");
    expect(skippedNote).toContain("doc.pdf");
    expect(skippedNote).toContain("note.txt");
  });

  test("handles various image MIME types", () => {
    const attachments: A2AAttachment[] = [
      {
        contentType: "image/png",
        contentBase64: VALID_IMAGE_BASE64,
        name: "a.png",
      },
      {
        contentType: "image/jpeg",
        contentBase64: VALID_IMAGE_BASE64,
        name: "b.jpg",
      },
      {
        contentType: "image/gif",
        contentBase64: VALID_IMAGE_BASE64,
        name: "c.gif",
      },
      {
        contentType: "image/webp",
        contentBase64: VALID_IMAGE_BASE64,
        name: "d.webp",
      },
      {
        contentType: "image/svg+xml",
        contentBase64: VALID_IMAGE_BASE64,
        name: "e.svg",
      },
    ];

    const { content } = buildUserContent("Describe", attachments);

    expect(content).toHaveLength(6); // 1 text + 5 files
    expect(content?.[0]).toHaveProperty("type", "text");
    for (let i = 1; i < (content?.length ?? 0); i++) {
      expect(content?.[i]).toHaveProperty("type", "file");
    }
  });

  test("works with attachments that have no name", () => {
    const attachments: A2AAttachment[] = [
      {
        contentType: "image/png",
        contentBase64: VALID_IMAGE_BASE64,
      },
    ];

    const { content } = buildUserContent("What is this?", attachments);

    expect(content).toHaveLength(2);
    expect(content?.[0]).toEqual({ type: "text", text: "What is this?" });
    expect(content?.[1]).toHaveProperty("type", "file");
    expect(content?.[1]).toHaveProperty("mediaType", "image/png");
  });

  test("skipped note uses 'unnamed' for attachments without names", () => {
    const attachments: A2AAttachment[] = [
      {
        contentType: "application/pdf",
        contentBase64: "JVBERi0xLjQ=",
      },
    ];

    const { skippedNote } = buildUserContent("Hello", attachments);

    expect(skippedNote).toContain("unnamed (application/pdf)");
  });

  test("filters out tiny image attachments below MIN_IMAGE_ATTACHMENT_SIZE", () => {
    // Create a tiny image (~988 bytes, like broken Outlook inline references)
    // Base64 length of ~1317 chars → ~988 decoded bytes (below 2KB threshold)
    const tinyBase64 = "A".repeat(1317);

    // Create a valid-sized image (above 2KB threshold)
    // Base64 length of ~2732 chars → ~2048 decoded bytes
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

    const { content, skippedNote } = buildUserContent(
      "Check this",
      attachments,
    );

    // Should include only the valid image
    expect(content).toHaveLength(2); // 1 text + 1 file
    expect(content?.[1]).toHaveProperty("type", "file");
    expect(content?.[1]).toHaveProperty("mediaType", "image/jpeg");

    // Skipped note should mention the filtered tiny image
    expect(skippedNote).toContain("broken-inline-ref.png");
    expect(skippedNote).toContain("1 attachment(s)");
  });

  test("returns null content when all images are below minimum size", () => {
    const tinyBase64 = "A".repeat(100); // ~75 bytes

    const attachments: A2AAttachment[] = [
      {
        contentType: "image/png",
        contentBase64: tinyBase64,
        name: "tiny.png",
      },
    ];

    const { content, skippedNote } = buildUserContent("Hello", attachments);

    expect(content).toBeNull();
    expect(skippedNote).toContain("tiny.png");
  });

  test("does not filter images at or above the minimum size threshold", () => {
    // Create an image exactly at the threshold (2048 bytes = MIN_IMAGE_ATTACHMENT_SIZE)
    // 2048 bytes → base64 length = ceil(2048 * 4/3) = 2731 chars
    const thresholdBase64 = "C".repeat(2731);
    const estimatedBytes = Math.ceil((2731 * 3) / 4);
    expect(estimatedBytes).toBeGreaterThanOrEqual(MIN_IMAGE_ATTACHMENT_SIZE);

    const attachments: A2AAttachment[] = [
      {
        contentType: "image/png",
        contentBase64: thresholdBase64,
        name: "threshold.png",
      },
    ];

    const { content } = buildUserContent("Test", attachments);

    expect(content).toHaveLength(2); // 1 text + 1 file
    expect(content?.[1]).toHaveProperty("type", "file");
  });
});

describe("executeA2AMessage model selection", () => {
  test("uses the shared conversation selection so delegated agents inherit the organization default model", async () => {
    vi.mocked(AgentModel.findById).mockResolvedValue({
      id: "agent-child",
      name: "Child Agent",
      agentType: "agent",
      systemPrompt: "Handle the task.",
      llmApiKeyId: null,
      llmModel: null,
    } as never);
    vi.mocked(McpServerModel.getUserPersonalServerForCatalog).mockResolvedValue(
      null,
    );
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
      text: Promise.resolve("Delegated response"),
      usage: Promise.resolve(undefined),
      finishReason: Promise.resolve("stop"),
    });

    const result = await executeA2AMessage({
      agentId: "agent-child",
      message: "Handle this",
      organizationId: "org-1",
      userId: "user-1",
      conversationId: "conv-1",
      parentDelegationChain: "agent-parent",
    });

    expect(mockResolveConversationLlmSelectionForAgent).toHaveBeenCalledWith({
      agent: {
        llmApiKeyId: null,
        llmModel: null,
      },
      organizationId: "org-1",
      userId: "user-1",
    });
    expect(mockCreateLLMModelForAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        userId: "user-1",
        agentId: "agent-child",
        model: "gemini-2.5-pro",
        provider: "gemini",
        externalAgentId: "agent-parent:agent-child",
      }),
    );
    expect(result.text).toBe("Delegated response");
  });
});

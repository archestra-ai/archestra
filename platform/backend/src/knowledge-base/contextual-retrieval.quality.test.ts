import { createOpenAI } from "@ai-sdk/openai";
import type { TextSearchLanguage } from "@archestra/shared";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import { KbChunkModel, KbDocumentModel } from "@/models";
import { describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";

vi.mock("@/clients/anthropic-endpoint", () => ({
  isAnthropicNativeEndpoint: vi.fn().mockReturnValue(false),
}));

const mockResolveContextualRetrievalConfig = vi.hoisted(() => vi.fn());
vi.mock("./kb-llm-client", () => ({
  resolveContextualRetrievalConfig: mockResolveContextualRetrievalConfig,
}));

vi.mock("./kb-interaction", () => ({
  withKbObservability: vi.fn().mockImplementation(({ callback }) => callback()),
  getProviderChatInteractionType: vi
    .fn()
    .mockReturnValue("openai:chatCompletions"),
}));

import { buildContextualHeaders } from "./contextual-retrieval";

const TEST_BASE_URL = "https://llm.test/v1";
const TARGET_CHUNK_INDEX = 12;
const PASSAGES = Array.from(
  { length: 16 },
  (_, index) => `Operational note ${index}: the scheduled work completed.`,
);
const RERANKER_CONFIG = {
  kind: "llm" as const,
  baseUrl: null,
  llmModel: createOpenAI({
    baseURL: TEST_BASE_URL,
    apiKey: "test-key",
  }).chat("gpt-4o-mini"),
  modelName: "gpt-4o-mini",
  provider: "openai" as const,
};

describe("contextual retrieval quality/cost comparison", () => {
  const server = useMswServer();

  test("measures the passage precision gain beside its extra generation calls", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const organization = await makeOrganization();
    const knowledgeBase = await makeKnowledgeBase(organization.id);
    const connector = await makeKnowledgeBaseConnector(
      knowledgeBase.id,
      organization.id,
    );
    const document = await KbDocumentModel.create({
      connectorId: connector.id,
      organizationId: organization.id,
      title: "Quarterly engineering review",
      content: PASSAGES.join("\n\n"),
      contentHash: "context-quality-comparison",
      embeddingStatus: "pending",
    });
    let activeMode: "document" | "chunk" = "document";
    let modelCalls = 0;
    server.use(
      http.post(`${TEST_BASE_URL}/chat/completions`, () => {
        modelCalls++;
        if (activeMode === "document") {
          return chatCompletion(
            "The review covers Project Cedar's database migration and several unrelated projects.",
          );
        }

        const batchStart = (modelCalls - 1) * 8;
        return chatCompletion(
          JSON.stringify({
            contexts: Array.from({ length: 8 }, (_, offset) => {
              const chunkIndex = batchStart + offset;
              return chunkIndex === TARGET_CHUNK_INDEX
                ? "Project Cedar database migration passage."
                : `Project Maple application rollout passage ${chunkIndex}.`;
            }),
          }),
        );
      }),
    );

    const documentMetrics = await evaluateMode({
      mode: "document",
      beforeGenerate: () => {
        activeMode = "document";
        modelCalls = 0;
      },
      afterGenerate: () => modelCalls,
      documentId: document.id,
      connectorId: connector.id,
      organizationId: organization.id,
      ftsLanguage: connector.ftsLanguage,
    });
    await KbChunkModel.deleteByDocument(document.id);
    const chunkMetrics = await evaluateMode({
      mode: "chunk",
      beforeGenerate: () => {
        activeMode = "chunk";
        modelCalls = 0;
      },
      afterGenerate: () => modelCalls,
      documentId: document.id,
      connectorId: connector.id,
      organizationId: organization.id,
      ftsLanguage: connector.ftsLanguage,
    });

    expect({ document: documentMetrics, chunk: chunkMetrics }).toEqual({
      document: {
        generationCalls: 1,
        matchingPassages: 16,
        relevantPassages: 1,
        precision: 1 / 16,
      },
      chunk: {
        generationCalls: 2,
        matchingPassages: 1,
        relevantPassages: 1,
        precision: 1,
      },
    });
  });
});

async function evaluateMode(params: {
  mode: "document" | "chunk";
  beforeGenerate: () => void;
  afterGenerate: () => number;
  documentId: string;
  connectorId: string;
  organizationId: string;
  ftsLanguage: TextSearchLanguage;
}) {
  params.beforeGenerate();
  mockResolveContextualRetrievalConfig.mockResolvedValue({
    mode: params.mode,
    reranker: RERANKER_CONFIG,
  });
  const contextualHeaders = await buildContextualHeaders({
    title: "Quarterly engineering review",
    content: PASSAGES.join("\n\n"),
    chunks: PASSAGES,
    organizationId: params.organizationId,
    connectorId: params.connectorId,
  });
  await KbChunkModel.insertMany(
    PASSAGES.map((content, chunkIndex) => ({
      documentId: params.documentId,
      content,
      chunkIndex,
      contextualHeader: contextualHeaders[chunkIndex],
      ftsLanguage: params.ftsLanguage,
      acl: ["org:*"],
    })),
  );
  const matches = await KbChunkModel.fullTextSearch({
    connectorIds: [params.connectorId],
    queryText: "Project Cedar database migration",
    languages: [params.ftsLanguage],
    userAcl: [],
    bypassAcl: true,
    limit: PASSAGES.length,
  });
  const relevantPassages = matches.filter(
    (match) => match.chunkIndex === TARGET_CHUNK_INDEX,
  ).length;

  return {
    generationCalls: params.afterGenerate(),
    matchingPassages: matches.length,
    relevantPassages,
    precision: relevantPassages / matches.length,
  };
}

function chatCompletion(content: string) {
  return HttpResponse.json({
    id: "chatcmpl-quality",
    object: "chat.completion",
    created: 0,
    model: "gpt-4o-mini",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  });
}

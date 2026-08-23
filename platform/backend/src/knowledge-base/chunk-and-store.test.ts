import { vi } from "vitest";

const mockBuildContextualHeaders = vi.hoisted(() => vi.fn());
vi.mock("./contextual-retrieval", () => ({
  buildContextualHeaders: mockBuildContextualHeaders,
}));

import logger from "@/logging";
import { KbChunkModel, KbDocumentModel } from "@/models";
import { describe, expect, test } from "@/test";
import { chunkAndStoreDocument } from "./chunk-and-store";

describe("chunkAndStoreDocument", () => {
  test("persists each generated context on its matching chunk", async ({
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
    const content = Array.from(
      { length: 5 },
      (_, index) => `Section ${index}. ${"detail ".repeat(700)}`,
    ).join("\n\n");
    const document = await KbDocumentModel.create({
      connectorId: connector.id,
      organizationId: organization.id,
      title: "Engineering review",
      content,
      contentHash: "context-header-persistence",
      embeddingStatus: "pending",
    });
    mockBuildContextualHeaders.mockImplementation(
      async ({ chunks }: { chunks: string[] }) =>
        chunks.map((_, index) => `CONTEXT: Passage ${index}\n\n`),
    );

    await chunkAndStoreDocument({
      documentId: document.id,
      title: document.title,
      content,
      connectorType: connector.connectorType,
      connectorId: connector.id,
      organizationId: organization.id,
      ftsLanguage: connector.ftsLanguage,
      acl: ["org:*"],
      log: logger,
    });

    const storedChunks = await KbChunkModel.findByDocument(document.id);
    expect(storedChunks.length).toBeGreaterThan(1);
    expect(mockBuildContextualHeaders).toHaveBeenCalledWith({
      title: document.title,
      content,
      chunks: storedChunks.map((chunk) => chunk.content),
      organizationId: organization.id,
      connectorId: connector.id,
    });
    expect(storedChunks.map((chunk) => chunk.contextualHeader)).toEqual(
      storedChunks.map((_, index) => `CONTEXT: Passage ${index}\n\n`),
    );
  });
});

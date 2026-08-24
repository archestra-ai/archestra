import { vi } from "vitest";

const mockBuildContextualHeaders = vi.hoisted(() => vi.fn());
vi.mock("./contextual-retrieval", () => ({
  buildContextualHeaders: mockBuildContextualHeaders,
}));

// Parent/child indexing is an ingest-time setting, so it is fixed for the file
// rather than per test. `chunk-and-store.test.ts` covers the single-pass
// default alongside this.
vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    kb: { chunkSizeTokens: 512, childChunkSizeTokens: 128 },
  }),
);

import logger from "@/logging";
import { KbChunkModel, KbDocumentModel } from "@/models";
import { describe, expect, test } from "@/test";
import { chunkAndStoreDocument } from "./chunk-and-store";

describe("chunkAndStoreDocument under parent/child indexing", () => {
  test("stores children under their passage and contextualizes once per passage", async ({
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
      { length: 6 },
      (_, index) =>
        `Section ${index}. ${"Operational detail about the ingest pipeline. ".repeat(60)}`,
    ).join("\n\n");
    const document = await KbDocumentModel.create({
      connectorId: connector.id,
      organizationId: organization.id,
      title: "Engineering review",
      content,
      contentHash: "parent-child-persistence",
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
    const parentIndexes = storedChunks.map((chunk) => chunk.parentIndex);
    const passageCount = new Set(parentIndexes).size;

    // Every stored chunk is a child of some passage, and there are strictly
    // more children than passages — otherwise nothing was subdivided.
    expect(parentIndexes.every((index) => index !== null)).toBe(true);
    expect(storedChunks.length).toBeGreaterThan(passageCount);

    // Context was generated once per PASSAGE, not once per stored chunk: at a
    // quarter the chunk size, doing it per child would multiply the generation
    // calls to produce near-identical text.
    expect(mockBuildContextualHeaders).toHaveBeenCalledTimes(1);
    const [call] = mockBuildContextualHeaders.mock.calls[0];
    expect(call.chunks).toHaveLength(passageCount);

    // ...and each child inherits the header of the passage it came from.
    for (const chunk of storedChunks) {
      expect(chunk.contextualHeader).toBe(
        `CONTEXT: Passage ${chunk.parentIndex}\n\n`,
      );
    }
  });
});

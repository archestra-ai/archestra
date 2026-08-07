import { KbChunkModel, KbDocumentModel } from "@/models";
import type { VectorSearchResult } from "@/models/kb-chunk";
import { describe, expect, test } from "@/test";
import { expandChunkContext } from "./context-expansion";

/**
 * Build the search-result shape the query pipeline hands to expansion. Only the
 * identity fields matter here — expansion never reads score or citation.
 */
function asResult(chunk: {
  id: string;
  documentId: string;
  chunkIndex: number;
  content: string;
}): VectorSearchResult {
  return {
    id: chunk.id,
    content: chunk.content,
    chunkIndex: chunk.chunkIndex,
    documentId: chunk.documentId,
    sourceId: null,
    title: "Test Document",
    sourceUrl: null,
    metadata: null,
    connectorType: "jira",
    score: 1,
  };
}

async function seedDocument(params: {
  organizationId: string;
  connectorId: string;
  chunks: Array<{ content: string; acl?: string[] }>;
  hash: string;
}) {
  const doc = await KbDocumentModel.create({
    connectorId: params.connectorId,
    organizationId: params.organizationId,
    title: "Test Document",
    content: "irrelevant",
    contentHash: params.hash,
    embeddingStatus: "completed",
  });

  await KbChunkModel.insertMany(
    params.chunks.map((chunk, index) => ({
      documentId: doc.id,
      content: chunk.content,
      chunkIndex: index,
      acl: chunk.acl ?? ["org:*"],
    })),
  );

  return { doc, chunks: await KbChunkModel.findByDocument(doc.id) };
}

describe("expandChunkContext", () => {
  test("stitches the neighbouring chunks around a hit", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

    const { chunks } = await seedDocument({
      organizationId: org.id,
      connectorId: connector.id,
      hash: "expand-basic",
      chunks: [
        { content: "Chunk zero." },
        { content: "Chunk one." },
        { content: "Chunk two." },
      ],
    });

    const [expanded] = await expandChunkContext({
      results: [asResult(chunks[1])],
      radius: 1,
      userAcl: ["org:*"],
    });

    expect(expanded.content).toBe("Chunk zero.\n\nChunk one.\n\nChunk two.");
    // Ranking identity is untouched — only the text the model reads is wider.
    expect(expanded.id).toBe(chunks[1].id);
    expect(expanded.chunkIndex).toBe(1);
  });

  test("radius 0 returns the hits untouched", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

    const { chunks } = await seedDocument({
      organizationId: org.id,
      connectorId: connector.id,
      hash: "expand-off",
      chunks: [{ content: "Chunk zero." }, { content: "Chunk one." }],
    });

    const [expanded] = await expandChunkContext({
      results: [asResult(chunks[1])],
      radius: 0,
      userAcl: ["org:*"],
    });

    expect(expanded.content).toBe("Chunk one.");
  });

  test("a neighbour the user cannot read is left out", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

    // Chunk ACLs are per-row: a permission sync can legitimately leave one chunk
    // of a document readable and its neighbour restricted. Expansion must not
    // become a way to read the restricted one.
    const { chunks } = await seedDocument({
      organizationId: org.id,
      connectorId: connector.id,
      hash: "expand-acl",
      chunks: [
        { content: "Secret preceding chunk.", acl: ["team:secret"] },
        { content: "Readable chunk.", acl: ["org:*"] },
        { content: "Readable following chunk.", acl: ["org:*"] },
      ],
    });

    const [expanded] = await expandChunkContext({
      results: [asResult(chunks[1])],
      radius: 1,
      userAcl: ["org:*"],
    });

    expect(expanded.content).not.toContain("Secret preceding chunk.");
    expect(expanded.content).toBe(
      "Readable chunk.\n\nReadable following chunk.",
    );
  });

  test("stops at a gap instead of splicing non-adjacent passages", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

    // Chunk 1 is unreadable, so chunk 0 must not be pulled in behind it —
    // presenting 0 and 2 as one passage would fabricate continuity.
    const { chunks } = await seedDocument({
      organizationId: org.id,
      connectorId: connector.id,
      hash: "expand-gap",
      chunks: [
        { content: "Chunk zero." },
        { content: "Hidden chunk one.", acl: ["team:secret"] },
        { content: "Chunk two." },
        { content: "Chunk three." },
      ],
    });

    const [expanded] = await expandChunkContext({
      results: [asResult(chunks[2])],
      radius: 2,
      userAcl: ["org:*"],
    });

    expect(expanded.content).not.toContain("Chunk zero.");
    expect(expanded.content).toBe("Chunk two.\n\nChunk three.");
  });

  test("does not repeat text already returned as its own hit", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

    const { chunks } = await seedDocument({
      organizationId: org.id,
      connectorId: connector.id,
      hash: "expand-overlap",
      chunks: [
        { content: "Chunk zero." },
        { content: "Chunk one." },
        { content: "Chunk two." },
      ],
    });

    const expanded = await expandChunkContext({
      results: [asResult(chunks[0]), asResult(chunks[1])],
      radius: 1,
      userAcl: ["org:*"],
    });

    // Each hit keeps its own chunk, and chunk two is claimed once by the
    // adjacent hit rather than appearing under both.
    expect(expanded[0].content).toBe("Chunk zero.");
    expect(expanded[1].content).toBe("Chunk one.\n\nChunk two.");
  });

  test("keeps the title prefix once instead of on every stitched chunk", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

    const { chunks } = await seedDocument({
      organizationId: org.id,
      connectorId: connector.id,
      hash: "expand-title",
      chunks: [
        { content: "TITLE: Runbook\n\nFirst part." },
        { content: "TITLE: Runbook\n\nSecond part." },
      ],
    });

    const [expanded] = await expandChunkContext({
      results: [asResult(chunks[0])],
      radius: 1,
      userAcl: ["org:*"],
    });

    expect(expanded.content).toBe(
      "TITLE: Runbook\n\nFirst part.\n\nSecond part.",
    );
  });

  test("leaves media chunks alone", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

    // An image chunk's content is a base64 data URL; stitching prose onto it
    // would corrupt it, and stitching it into prose would dump base64 into the
    // model's context.
    const { chunks } = await seedDocument({
      organizationId: org.id,
      connectorId: connector.id,
      hash: "expand-media",
      chunks: [
        { content: "data:image/png;base64,AAAA" },
        { content: "Adjacent prose chunk." },
      ],
    });

    const [expanded] = await expandChunkContext({
      results: [asResult(chunks[0])],
      radius: 1,
      userAcl: ["org:*"],
    });

    expect(expanded.content).toBe("data:image/png;base64,AAAA");
  });
});

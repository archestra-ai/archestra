import { KbChunkModel, KbDocumentModel } from "@/models";
import type { VectorSearchResult } from "@/models/kb-chunk";
import { describe, expect, test } from "@/test";
import {
  collapseParentSiblings,
  resolveParentPassages,
} from "./parent-passage";

/**
 * A search hit. Only identity fields matter — parent resolution never reads
 * score or citation.
 */
function asResult(chunk: {
  id: string;
  documentId: string;
  chunkIndex: number;
  parentIndex: number | null;
  content: string;
}): VectorSearchResult {
  return {
    id: chunk.id,
    content: chunk.content,
    chunkIndex: chunk.chunkIndex,
    parentIndex: chunk.parentIndex,
    documentId: chunk.documentId,
    sourceId: null,
    title: "Test Document",
    sourceUrl: null,
    metadata: null,
    connectorType: "confluence",
    score: 1,
  };
}

async function seedDocument(params: {
  organizationId: string;
  connectorId: string;
  chunks: Array<{
    content: string;
    parentIndex: number | null;
    acl?: string[];
  }>;
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
      parentIndex: chunk.parentIndex,
      acl: chunk.acl ?? ["org:*"],
    })),
  );

  return { doc, chunks: await KbChunkModel.findByDocument(doc.id) };
}

describe("collapseParentSiblings", () => {
  test("keeps only the best-ranked child of each passage", () => {
    const hit = (id: string, parentIndex: number | null, chunkIndex: number) =>
      asResult({
        id,
        documentId: "doc-a",
        chunkIndex,
        parentIndex,
        content: id,
      });

    const collapsed = collapseParentSiblings([
      hit("first-of-passage-0", 0, 0),
      hit("second-of-passage-0", 0, 1),
      hit("first-of-passage-1", 1, 4),
      hit("third-of-passage-0", 0, 2),
    ]);

    expect(collapsed.map((r) => r.id)).toEqual([
      "first-of-passage-0",
      "first-of-passage-1",
    ]);
  });

  test("does not confuse the same passage ordinal in different documents", () => {
    const collapsed = collapseParentSiblings([
      asResult({
        id: "a",
        documentId: "doc-a",
        chunkIndex: 0,
        parentIndex: 0,
        content: "a",
      }),
      asResult({
        id: "b",
        documentId: "doc-b",
        chunkIndex: 0,
        parentIndex: 0,
        content: "b",
      }),
    ]);

    expect(collapsed.map((r) => r.id)).toEqual(["a", "b"]);
  });

  test("leaves chunks that are their own passage untouched", () => {
    const collapsed = collapseParentSiblings([
      asResult({
        id: "a",
        documentId: "doc-a",
        chunkIndex: 0,
        parentIndex: null,
        content: "a",
      }),
      asResult({
        id: "b",
        documentId: "doc-a",
        chunkIndex: 1,
        parentIndex: null,
        content: "b",
      }),
    ]);

    expect(collapsed.map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("resolveParentPassages", () => {
  test("returns the whole passage behind a hit on one of its children", async ({
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
      hash: "resolve-passage",
      chunks: [
        {
          content: "The ingest pipeline accepts batched events.",
          parentIndex: 0,
        },
        { content: "The ingest service listens on port 8080.", parentIndex: 0 },
        { content: "Events are written to the durable queue.", parentIndex: 0 },
        { content: "An unrelated later passage.", parentIndex: 1 },
      ],
    });

    const [resolved] = await resolveParentPassages({
      results: [asResult(chunks[1])],
      userAcl: ["org:*"],
    });

    // The specific fact still matched on its own small chunk, but what comes
    // back is the passage that explains it.
    expect(resolved.content).toBe(
      [
        "The ingest pipeline accepts batched events.",
        "The ingest service listens on port 8080.",
        "Events are written to the durable queue.",
      ].join("\n\n"),
    );
    // The passage stops at its own boundary — the next one is a separate result.
    expect(resolved.content).not.toContain("unrelated later passage");
  });

  test("repeats the title prefix only once across a stitched passage", async ({
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
      hash: "resolve-title",
      chunks: [
        {
          content: "TITLE: Runbook\n\nFirst half of the passage.",
          parentIndex: 0,
        },
        {
          content: "TITLE: Runbook\n\nSecond half of the passage.",
          parentIndex: 0,
        },
      ],
    });

    const [resolved] = await resolveParentPassages({
      results: [asResult(chunks[0])],
      userAcl: ["org:*"],
    });

    expect(resolved.content).toBe(
      "TITLE: Runbook\n\nFirst half of the passage.\n\nSecond half of the passage.",
    );
  });

  test("omits a sibling the user may not read", async ({
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
      hash: "resolve-acl",
      chunks: [
        { content: "Readable opening of the passage.", parentIndex: 0 },
        { content: "Readable middle of the passage.", parentIndex: 0 },
        {
          content: "Restricted remainder of the passage.",
          parentIndex: 0,
          acl: ["team:restricted"],
        },
      ],
    });

    const [resolved] = await resolveParentPassages({
      results: [asResult(chunks[0])],
      userAcl: ["org:*"],
    });

    expect(resolved.content).toBe(
      "Readable opening of the passage.\n\nReadable middle of the passage.",
    );
    expect(resolved.content).not.toContain("Restricted");
  });

  test("leaves a chunk that is its own passage alone", async ({
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
      hash: "resolve-legacy",
      chunks: [
        {
          content: "A chunk indexed before parent/child existed.",
          parentIndex: null,
        },
        { content: "Its neighbour, also parentless.", parentIndex: null },
      ],
    });

    const results = await resolveParentPassages({
      results: [asResult(chunks[0])],
      userAcl: ["org:*"],
    });

    expect(results[0].content).toBe(
      "A chunk indexed before parent/child existed.",
    );
  });

  test("serves a mixed result set, resolving only the children in it", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    // A deployment that enables parent/child keeps its previously-indexed
    // corpora until they re-sync, so one query can span both shapes.
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

    const { chunks: childChunks } = await seedDocument({
      organizationId: org.id,
      connectorId: connector.id,
      hash: "resolve-mixed-new",
      chunks: [
        { content: "New-style opening.", parentIndex: 0 },
        { content: "New-style continuation.", parentIndex: 0 },
      ],
    });
    const { chunks: legacyChunks } = await seedDocument({
      organizationId: org.id,
      connectorId: connector.id,
      hash: "resolve-mixed-old",
      chunks: [{ content: "Old-style whole chunk.", parentIndex: null }],
    });

    const results = await resolveParentPassages({
      results: [asResult(childChunks[0]), asResult(legacyChunks[0])],
      userAcl: ["org:*"],
    });

    expect(results.map((r) => r.content)).toEqual([
      "New-style opening.\n\nNew-style continuation.",
      "Old-style whole chunk.",
    ]);
  });
});

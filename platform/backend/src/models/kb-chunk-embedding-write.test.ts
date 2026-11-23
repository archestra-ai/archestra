import { KbChunkModel, KbDocumentModel } from "@/models";
import { expect, test } from "@/test";
import { recordQueries } from "@/test/query-counter";

// Outside the rollback suite: there the outer transaction is opened before the
// statements can be recorded.
test("updateEmbeddings binds vector values as a parameter, never inline SQL", async ({
  makeOrganization,
  makeKnowledgeBase,
  makeKnowledgeBaseConnector,
}) => {
  const org = await makeOrganization();
  const kb = await makeKnowledgeBase(org.id);
  const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
  const doc = await KbDocumentModel.create({
    connectorId: connector.id,
    organizationId: org.id,
    title: "Embedding write invariant",
    content: "body",
    contentHash: `embedding-write-${crypto.randomUUID()}`,
  });
  const [chunk] = await KbChunkModel.insertMany([
    { documentId: doc.id, content: "chunk", chunkIndex: 0 },
  ]);

  // A value unlikely to appear anywhere in the query text on its own.
  const SENTINEL = "123456.789";
  const vector = Array.from({ length: 1024 }, (_, i) =>
    i === 0 ? Number(SENTINEL) : 0.1,
  );

  const { statements } = await recordQueries(() =>
    KbChunkModel.updateEmbeddings(
      [{ chunkId: chunk.id, embedding: vector }],
      1024,
    ),
  );

  const writes = statements.filter((sql) => sql.includes("UPDATE kb_chunks"));
  expect(writes.length).toBeGreaterThan(0);
  for (const sql of writes) {
    expect(sql).not.toContain(SENTINEL);
  }

  // And it was really stored, so the parameter path works end to end.
  const [stored] = await KbChunkModel.findByDocument(doc.id);
  expect(stored.embedding1024?.[0]).toBeCloseTo(Number(SENTINEL));
});

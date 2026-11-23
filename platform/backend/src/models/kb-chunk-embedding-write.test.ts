import db from "@/database";
import { KbChunkModel, KbDocumentModel } from "@/models";
import { expect, test, vi } from "@/test";

/**
 * Security invariant for the embedding write: a vector value must travel to
 * Postgres as a bound parameter, never spliced into the SQL text. A malicious
 * embedding endpoint controls these values, so if they ever reached the query
 * as text they would be parsed as SQL. This test fails if the write regresses
 * to the old string-concatenation form.
 *
 * It lives outside the rollback suite because it captures the statements the
 * model issues inside its own transaction; a shared outer transaction would
 * route them through a different connection.
 */
test("updateEmbeddings binds vector values as a parameter, never inline SQL", async ({
  makeOrganization,
  makeKnowledgeBase,
  makeKnowledgeBaseConnector,
}) => {
  const org = await makeOrganization({ legacyPermissions: true });
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

  // Capture every statement, whether it runs on the base connection or on the
  // connection the write's transaction opens.
  const statements: string[] = [];
  const client = db.$client as unknown as {
    query: (sql: unknown, ...rest: unknown[]) => Promise<unknown>;
    transaction: (
      cb: (tx: {
        query: (sql: unknown, ...rest: unknown[]) => Promise<unknown>;
      }) => Promise<unknown>,
    ) => Promise<unknown>;
  };
  const record = (sql: unknown) => statements.push(String(sql));

  const realQuery = client.query.bind(client);
  const querySpy = vi
    .spyOn(client, "query")
    .mockImplementation((sql, ...rest) => {
      record(sql);
      return realQuery(sql, ...rest);
    });

  const realTransaction = client.transaction.bind(client);
  const transactionSpy = vi
    .spyOn(client, "transaction")
    .mockImplementation((cb) =>
      realTransaction((tx) => {
        const realTxQuery = tx.query.bind(tx);
        tx.query = (sql, ...rest) => {
          record(sql);
          return realTxQuery(sql, ...rest);
        };
        return cb(tx);
      }),
    );

  try {
    await KbChunkModel.updateEmbeddings(
      [{ chunkId: chunk.id, embedding: vector }],
      1024,
    );
  } finally {
    querySpy.mockRestore();
    transactionSpy.mockRestore();
  }

  const writes = statements.filter((sql) => sql.includes("UPDATE kb_chunks"));
  expect(writes.length).toBeGreaterThan(0);
  for (const sql of writes) {
    // The value rides in a jsonb parameter, not the statement text.
    expect(sql).toContain("jsonb_to_recordset");
    expect(sql).not.toContain(SENTINEL);
  }

  // And it was really stored, so the parameter path works end to end.
  const [stored] = await KbChunkModel.findByDocument(doc.id);
  expect(stored.embedding1024?.[0]).toBeCloseTo(Number(SENTINEL));
});

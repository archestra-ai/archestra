import { vi } from "vitest";

// A cap of 2 with 5 matching chunks: small enough to see the boundary, large
// enough that the statement still has to choose.
vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    kb: { bm25RecallCap: 2 },
  }),
);

import { BM25_B_DEFAULT, BM25_K1_DEFAULT } from "@archestra/shared";
import { KbChunkModel, KbDocumentModel } from "@/models";
import { describe, expect, test } from "@/test";
import type { AclEntry } from "@/types";

const LUCENE_DEFAULTS = { k1: BM25_K1_DEFAULT, b: BM25_B_DEFAULT };

describe("BM25 recall cap", () => {
  async function seedMatchingChunks(
    fixtures: {
      makeOrganization: () => Promise<{ id: string }>;
      makeKnowledgeBase: (orgId: string) => Promise<{ id: string }>;
      makeKnowledgeBaseConnector: (
        kbId: string,
        orgId: string,
      ) => Promise<{ id: string }>;
    },
    acls: AclEntry[][],
  ) {
    const org = await fixtures.makeOrganization();
    const kb = await fixtures.makeKnowledgeBase(org.id);
    const connector = await fixtures.makeKnowledgeBaseConnector(kb.id, org.id);
    const doc = await KbDocumentModel.create({
      connectorId: connector.id,
      organizationId: org.id,
      title: "Runbooks",
      content: "gateway",
      contentHash: `h-cap-${connector.id}`,
    });
    await KbChunkModel.insertMany(
      acls.map((acl, index) => ({
        documentId: doc.id,
        content: `gateway watchdog restart procedure number ${index}`,
        chunkIndex: index,
        acl,
      })),
    );
    await KbChunkModel.refreshBm25Stats();
    return connector.id;
  }

  test("scores at most `bm25RecallCap` candidates", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const connectorId = await seedMatchingChunks(
      { makeOrganization, makeKnowledgeBase, makeKnowledgeBaseConnector },
      Array.from({ length: 5 }, () => ["org:*"] as AclEntry[]),
    );

    const results = await KbChunkModel.fullTextSearch({
      connectorIds: [connectorId],
      queryText: "gateway watchdog",
      bm25: LUCENE_DEFAULTS,
      userAcl: ["org:*"],
      limit: 10,
    });

    // limit is 10, so anything above 2 came from the cap being ignored.
    expect(results).toHaveLength(2);
  });

  test("the cap never lets a caller past the ACL filter", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    // Four chunks the caller cannot read, one they can. If the cap were applied
    // before the ACL predicate, the readable chunk would fall outside the
    // candidate window and the caller would get nothing — or worse, a chunk
    // they must not see.
    const connectorId = await seedMatchingChunks(
      { makeOrganization, makeKnowledgeBase, makeKnowledgeBaseConnector },
      [
        ["team:secret"],
        ["team:secret"],
        ["team:secret"],
        ["team:secret"],
        ["org:*"],
      ],
    );

    const results = await KbChunkModel.fullTextSearch({
      connectorIds: [connectorId],
      queryText: "gateway watchdog",
      bm25: LUCENE_DEFAULTS,
      userAcl: ["org:*"],
      limit: 10,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.chunkIndex).toBe(4);
  });
});

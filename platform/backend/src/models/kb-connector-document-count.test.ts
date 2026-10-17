import { count, inArray } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import type { InsertKbDocument } from "@/types";
import KbConnectorDocumentCountModel from "./kb-connector-document-count";
import KbDocumentModel from "./kb-document";
import KnowledgeBaseConnectorModel from "./knowledge-base-connector";

describe("KbConnectorDocumentCountModel", () => {
  test("counts a connector on first read and keeps that total until a writer replaces it", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
    const empty = await makeKnowledgeBaseConnector(kb.id, org.id);
    for (let i = 0; i < 3; i++) {
      await KbDocumentModel.create(documentData(connector.id, org.id));
    }

    expect(
      await KbConnectorDocumentCountModel.findByConnectorIds([
        connector.id,
        empty.id,
      ]),
    ).toEqual(
      new Map([
        [connector.id, 3],
        [empty.id, 0],
      ]),
    );

    // Stored, not recounted: a write nobody refreshed after stays invisible.
    await KbDocumentModel.create(documentData(connector.id, org.id));
    expect(
      await KbConnectorDocumentCountModel.findByConnectorIds([connector.id]),
    ).toEqual(new Map([[connector.id, 3]]));

    expect(await KbConnectorDocumentCountModel.refresh(connector.id)).toBe(4);
    expect(await KbConnectorDocumentCountModel.refresh(connector.id)).toBe(4);
    expect(
      await KbConnectorDocumentCountModel.findByConnectorIds([connector.id]),
    ).toEqual(new Map([[connector.id, 4]]));
  });

  test("sums the connectors of each knowledge base, soft-deleted ones included", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const withoutConnectors = await makeKnowledgeBase(org.id);
    const a = await makeKnowledgeBaseConnector(kb.id, org.id);
    const b = await makeKnowledgeBaseConnector(kb.id, org.id);
    await KbDocumentModel.create(documentData(a.id, org.id));
    await KbDocumentModel.create(documentData(a.id, org.id));
    await KbDocumentModel.create(documentData(b.id, org.id));
    await KnowledgeBaseConnectorModel.delete(b.id);

    expect(
      await KbConnectorDocumentCountModel.sumByKnowledgeBaseIds([
        kb.id,
        withoutConnectors.id,
      ]),
    ).toEqual(new Map([[kb.id, 3]]));
  });

  test("recounts an organization's connectors, optionally of one type only", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const jira = await makeKnowledgeBaseConnector(kb.id, org.id);
    const uploads = await makeKnowledgeBaseConnector(kb.id, org.id, {
      connectorType: "file_upload",
      config: {} as never,
    });
    await KbDocumentModel.create(documentData(jira.id, org.id));
    await KbDocumentModel.create(documentData(uploads.id, org.id));
    await KbConnectorDocumentCountModel.findByConnectorIds([
      jira.id,
      uploads.id,
    ]);
    await KbDocumentModel.deleteByOrganization(org.id);

    await KbConnectorDocumentCountModel.refreshForOrganization({
      organizationId: org.id,
      connectorType: "file_upload",
    });
    expect(
      await KbConnectorDocumentCountModel.findByConnectorIds([
        jira.id,
        uploads.id,
      ]),
    ).toEqual(
      new Map([
        [jira.id, 1],
        [uploads.id, 0],
      ]),
    );

    await KbConnectorDocumentCountModel.refreshForOrganization({
      organizationId: org.id,
    });
    expect(
      await KbConnectorDocumentCountModel.findByConnectorIds([jira.id]),
    ).toEqual(new Map([[jira.id, 0]]));
  });

  test("counts and stores more connectors than one statement batch holds", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connectors = await db
      .insert(schema.knowledgeBaseConnectorsTable)
      .values(
        Array.from({ length: 1001 }, (_, i) => ({
          organizationId: org.id,
          name: `Batch connector ${i}`,
          connectorType: "jira" as const,
          config: {
            type: "jira" as const,
            jiraBaseUrl: "https://test.atlassian.net",
            isCloud: true,
            projectKey: "TEST",
          },
        })),
      )
      .returning({ id: schema.knowledgeBaseConnectorsTable.id });
    const ids = connectors.map((connector) => connector.id);
    const first = ids[0];
    const last = ids[ids.length - 1];
    await KbDocumentModel.create(documentData(first, org.id));
    await KbDocumentModel.create(documentData(last, org.id));

    const totals = await KbConnectorDocumentCountModel.findByConnectorIds(ids);
    expect(totals.size).toBe(1001);
    expect(totals.get(first)).toBe(1);
    expect(totals.get(last)).toBe(1);
    const [stored] = await db
      .select({ rows: count() })
      .from(schema.kbConnectorDocumentCountsTable)
      .where(inArray(schema.kbConnectorDocumentCountsTable.connectorId, ids));
    expect(stored.rows).toBe(1001);

    await KbDocumentModel.create(documentData(last, org.id));
    await KbConnectorDocumentCountModel.refreshForOrganization({
      organizationId: org.id,
    });
    expect(
      await KbConnectorDocumentCountModel.findByConnectorIds([first, last]),
    ).toEqual(
      new Map([
        [first, 1],
        [last, 2],
      ]),
    );
  });
});

function documentData(
  connectorId: string,
  organizationId: string,
): InsertKbDocument {
  const id = crypto.randomUUID();
  return {
    connectorId,
    organizationId,
    sourceId: id,
    title: `Document ${id}`,
    content: `Content ${id}`,
    contentHash: `hash-${id}`,
  };
}

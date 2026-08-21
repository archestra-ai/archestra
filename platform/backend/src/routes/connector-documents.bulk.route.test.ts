import config from "@/config";
import db, { schema } from "@/database";
import { buildGroupToken } from "@/knowledge-base/acl-tokens";
import { KbDocumentModel, KnowledgeBaseConnectorModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("DELETE /api/connectors/:id/documents/bulk", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;
  let connectorId: string;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    config.kb.autoSyncPermissionsEnabled = true;
    user = await makeUser();
    organizationId = (await makeOrganization()).id;

    const connector = await KnowledgeBaseConnectorModel.create({
      organizationId,
      name: "docs-connector",
      connectorType: "jira",
      config: {
        type: "jira",
        jiraBaseUrl: "https://docs-connector.atlassian.net",
        isCloud: true,
        projectKey: "CD",
      },
    });
    connectorId = connector.id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });

    const { default: knowledgeBaseRoutes } = await import("./knowledge-base");
    await app.register(knowledgeBaseRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  const makeDocument = async (
    title: string,
    forConnectorId = connectorId,
    acl: string[] = [],
  ) => {
    const [row] = await db
      .insert(schema.kbDocumentsTable)
      .values({
        organizationId,
        connectorId: forConnectorId,
        sourceId: `src-${title}`,
        title,
        content: "body",
        contentHash: `hash-${title}`,
        acl,
      })
      .returning();
    return row;
  };

  const bulkDelete = (ids: unknown, id = connectorId) =>
    app.inject({
      method: "DELETE",
      url: `/api/connectors/${id}/documents/bulk`,
      payload: { ids },
    });

  const stillExists = async (documentId: string) =>
    (
      await KbDocumentModel.findForBulkByConnector({
        documentIds: [documentId],
        connectorId,
        organizationId,
      })
    ).length > 0;

  test("deletes every named document and leaves the rest alone", async () => {
    const first = await makeDocument("doc-a");
    const second = await makeDocument("doc-b");
    const kept = await makeDocument("doc-kept");

    const response = await bulkDelete([first.id, second.id]);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      succeeded: [
        { id: first.id, name: "doc-a" },
        { id: second.id, name: "doc-b" },
      ],
      failed: [],
    });
    expect(await stillExists(first.id)).toBe(false);
    expect(await stillExists(kept.id)).toBe(true);
  });

  /**
   * The connector fence is the point: a document id is only meaningful
   * relative to the connector in the URL, so one belonging to a different
   * connector must read as "not found" rather than being deleted through the
   * wrong parent.
   */
  test("will not delete a document belonging to another connector", async () => {
    const other = await KnowledgeBaseConnectorModel.create({
      organizationId,
      name: "other-connector",
      connectorType: "jira",
      config: {
        type: "jira",
        jiraBaseUrl: "https://other.atlassian.net",
        isCloud: true,
        projectKey: "OC",
      },
    });
    const mine = await makeDocument("mine");
    const theirs = await makeDocument("theirs", other.id);

    const response = await bulkDelete([mine.id, theirs.id]);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      succeeded: [{ id: mine.id, name: "mine" }],
      failed: [{ id: theirs.id, name: null, error: "Document not found" }],
    });
    expect(
      await KbDocumentModel.findForBulkByConnector({
        documentIds: [theirs.id],
        connectorId: other.id,
        organizationId,
      }),
    ).toHaveLength(1);
  });

  test("collapses duplicate ids", async () => {
    const doc = await makeDocument("dupe");

    const response = await bulkDelete([doc.id, doc.id, doc.id]);

    expect(response.json().succeeded).toEqual([{ id: doc.id, name: "dupe" }]);
  });

  test("reports an unknown id without failing the batch", async () => {
    const doc = await makeDocument("known");
    const missing = crypto.randomUUID();

    const response = await bulkDelete([missing, doc.id]);

    expect(response.statusCode).toBe(200);
    expect(response.json().succeeded).toEqual([{ id: doc.id, name: "known" }]);
    expect(response.json().failed).toEqual([
      { id: missing, name: null, error: "Document not found" },
    ]);
  });

  /**
   * The connector is the same for every id, so a connector the caller cannot
   * see fails the request outright rather than being reported once per
   * document.
   */
  test("404s the whole request for a connector in another organization", async ({
    makeOrganization,
  }) => {
    const otherOrgId = (await makeOrganization()).id;
    const foreign = await KnowledgeBaseConnectorModel.create({
      organizationId: otherOrgId,
      name: "foreign",
      connectorType: "jira",
      config: {
        type: "jira",
        jiraBaseUrl: "https://foreign.atlassian.net",
        isCloud: true,
        projectKey: "FN",
      },
    });

    const response = await bulkDelete([crypto.randomUUID()], foreign.id);

    expect(response.statusCode).toBe(404);
  });

  describe("filter mode", () => {
    const bulkDeleteAll = (body: Record<string, unknown>, id = connectorId) =>
      app.inject({
        method: "DELETE",
        url: `/api/connectors/${id}/documents/bulk`,
        payload: { all: true, ...body },
      });

    /**
     * The reason filter mode exists: a corpus of tens of thousands cannot be
     * selected by posting uuids, so "select all matching" sends the filter and
     * the count comes back instead of a per-row list.
     */
    test("deletes every document when no filter narrows it", async () => {
      await makeDocument("alpha");
      await makeDocument("beta");
      await makeDocument("gamma");

      const response = await bulkDeleteAll({});

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        affected: 3,
        succeeded: [],
        failed: [],
      });
      expect(
        await KbDocumentModel.countByConnectorWithSearch({
          connectorId,
          organizationId,
        }),
      ).toBe(0);
    });

    /**
     * The delete has to match exactly what the table was showing, or it
     * destroys rows the user never saw. Same predicate, same result.
     */
    test("honours the same title search the listing uses", async () => {
      await makeDocument("keep-me");
      const target = await makeDocument("delete-me");
      await makeDocument("delete-me-too");

      const response = await bulkDeleteAll({ search: "delete-me" });

      expect(response.statusCode).toBe(200);
      expect(response.json().affected).toBe(2);

      const survivors = await KbDocumentModel.findListItemsByConnector({
        connectorId,
        organizationId,
      });
      expect(survivors.map((doc) => doc.title)).toEqual(["keep-me"]);
      expect(await stillExists(target.id)).toBe(false);
    });

    test("never reaches another connector's documents", async () => {
      const other = await KnowledgeBaseConnectorModel.create({
        organizationId,
        name: "untouched-connector",
        connectorType: "jira",
        config: {
          type: "jira",
          jiraBaseUrl: "https://untouched.atlassian.net",
          isCloud: true,
          projectKey: "UN",
        },
      });
      await makeDocument("mine");
      const theirs = await makeDocument("theirs", other.id);

      const response = await bulkDeleteAll({});

      expect(response.json().affected).toBe(1);
      expect(
        await KbDocumentModel.findForBulkByConnector({
          documentIds: [theirs.id],
          connectorId: other.id,
          organizationId,
        }),
      ).toHaveLength(1);
    });

    test("404s for a connector in another organization without deleting", async ({
      makeOrganization,
    }) => {
      const otherOrgId = (await makeOrganization()).id;
      const foreign = await KnowledgeBaseConnectorModel.create({
        organizationId: otherOrgId,
        name: "foreign-filter",
        connectorType: "jira",
        config: {
          type: "jira",
          jiraBaseUrl: "https://foreign-filter.atlassian.net",
          isCloud: true,
          projectKey: "FF",
        },
      });
      await makeDocument("mine");

      const response = await bulkDeleteAll({}, foreign.id);

      expect(response.statusCode).toBe(404);
      expect(
        await KbDocumentModel.countByConnectorWithSearch({
          connectorId,
          organizationId,
        }),
      ).toBe(1);
    });

    /**
     * `group` arrives as the bare upstream group id and has to be namespaced
     * before it can match a stored ACL entry — the same transform the listing
     * applies. Getting this wrong does not fail loudly: the raw id matches
     * nothing, so the delete would report success over zero rows while the
     * filtered table the user was looking at survived intact.
     */
    test("namespaces the group filter the same way the listing does", async () => {
      const engineering = buildGroupToken({
        connectorType: "jira",
        groupId: "engineering",
      });
      const support = buildGroupToken({
        connectorType: "jira",
        groupId: "support",
      });
      const targeted = await makeDocument("eng-doc", connectorId, [
        engineering,
      ]);
      const spared = await makeDocument("support-doc", connectorId, [support]);

      const response = await bulkDeleteAll({ group: "engineering" });

      expect(response.statusCode).toBe(200);
      expect(response.json().affected).toBe(1);
      expect(await stillExists(targeted.id)).toBe(false);
      expect(await stillExists(spared.id)).toBe(true);
    });

    test("reports zero rather than failing when nothing matches", async () => {
      await makeDocument("present");

      const response = await bulkDeleteAll({ search: "no-such-title" });

      expect(response.statusCode).toBe(200);
      expect(response.json().affected).toBe(0);
      expect(
        await KbDocumentModel.countByConnectorWithSearch({
          connectorId,
          organizationId,
        }),
      ).toBe(1);
    });
  });

  test("rejects an empty batch", async () => {
    expect((await bulkDelete([])).statusCode).toBe(400);
  });

  test("rejects a batch over the cap", async () => {
    const ids = Array.from({ length: 501 }, () => crypto.randomUUID());
    expect((await bulkDelete(ids)).statusCode).toBe(400);
  });
});

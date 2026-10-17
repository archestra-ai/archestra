import { describe, expect, test } from "@/test";
import type { InsertKbDocument } from "@/types";
import AgentModel from "./agent";
import AgentKnowledgeBaseModel from "./agent-knowledge-base";
import CreatedByModel from "./created-by";
import { KnowledgeBaseLabelModel } from "./entity-labels";
import KbConnectorDocumentCountModel from "./kb-connector-document-count";
import KbDocumentModel from "./kb-document";
import KnowledgeBaseModel from "./knowledge-base";
import KnowledgeBaseConnectorModel from "./knowledge-base-connector";
import ResourcePermissionSubjectModel from "./resource-permission-subject";

describe("KnowledgeBaseModel", () => {
  describe("create", () => {
    test("creates a knowledge base with required fields", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      const kb = await KnowledgeBaseModel.create({
        organizationId: org.id,
        name: "My Knowledge Base",
      });

      expect(kb.id).toBeDefined();
      expect(kb.organizationId).toBe(org.id);
      expect(kb.name).toBe("My Knowledge Base");
      expect(kb.status).toBe("active");
      expect(kb.description).toBeNull();
      expect(kb.createdAt).toBeInstanceOf(Date);
      expect(kb.updatedAt).toBeInstanceOf(Date);
    });

    test("creates a knowledge base with optional fields", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      const kb = await KnowledgeBaseModel.create({
        organizationId: org.id,
        name: "Team KB",
        description: "A reusable KB",
        status: "inactive",
      });

      expect(kb.description).toBe("A reusable KB");
      expect(kb.status).toBe("inactive");
    });
  });

  describe("findById", () => {
    test("returns a knowledge base by id", async ({
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id, { name: "Find Me KB" });

      const found = await KnowledgeBaseModel.findById(kb.id);

      expect(found).not.toBeNull();
      expect(found?.id).toBe(kb.id);
      expect(found?.name).toBe("Find Me KB");
    });

    test("returns null for non-existent id", async () => {
      const found = await KnowledgeBaseModel.findById(
        "00000000-0000-0000-0000-000000000000",
      );
      expect(found).toBeNull();
    });
  });

  describe("findByOrganization", () => {
    test("returns knowledge bases for an organization", async ({
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      await makeKnowledgeBase(org.id, { name: "KB 1" });
      await makeKnowledgeBase(org.id, { name: "KB 2" });

      const results = await KnowledgeBaseModel.findByOrganization({
        organizationId: org.id,
      });

      expect(results).toHaveLength(2);
    });

    test("does not return knowledge bases from other organizations", async ({
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org1 = await makeOrganization();
      const org2 = await makeOrganization();
      await makeKnowledgeBase(org1.id, { name: "Org1 KB" });
      await makeKnowledgeBase(org2.id, { name: "Org2 KB" });

      const results = await KnowledgeBaseModel.findByOrganization({
        organizationId: org1.id,
      });

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("Org1 KB");
    });

    test("returns results ordered by createdAt descending", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      // Use explicit timestamps to guarantee ordering
      const older = new Date("2024-01-01T00:00:00Z");
      const newer = new Date("2025-01-01T00:00:00Z");

      const kb1 = await KnowledgeBaseModel.create({
        organizationId: org.id,
        name: "Older KB",
      });
      // Manually set createdAt via update to guarantee different timestamps
      // Since we can't set createdAt via create, insert directly with db
      const { default: db, schema } = await import("@/database");
      const { eq } = await import("drizzle-orm");
      await db
        .update(schema.knowledgeBasesTable)
        .set({ createdAt: older })
        .where(eq(schema.knowledgeBasesTable.id, kb1.id));

      const kb2 = await KnowledgeBaseModel.create({
        organizationId: org.id,
        name: "Newer KB",
      });
      await db
        .update(schema.knowledgeBasesTable)
        .set({ createdAt: newer })
        .where(eq(schema.knowledgeBasesTable.id, kb2.id));

      const results = await KnowledgeBaseModel.findByOrganization({
        organizationId: org.id,
      });

      // Most recently created should be first
      expect(results[0].id).toBe(kb2.id);
      expect(results[1].id).toBe(kb1.id);
    });

    test("supports limit parameter", async ({
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      await makeKnowledgeBase(org.id);
      await makeKnowledgeBase(org.id);
      await makeKnowledgeBase(org.id);

      const results = await KnowledgeBaseModel.findByOrganization({
        organizationId: org.id,
        limit: 2,
      });

      expect(results).toHaveLength(2);
    });

    test("supports offset parameter", async ({
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      await makeKnowledgeBase(org.id, { name: "First" });
      await makeKnowledgeBase(org.id, { name: "Second" });
      await makeKnowledgeBase(org.id, { name: "Third" });

      const results = await KnowledgeBaseModel.findByOrganization({
        organizationId: org.id,
        limit: 2,
        offset: 1,
      });

      expect(results).toHaveLength(2);
    });

    test("returns empty array when organization has no knowledge bases", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      const results = await KnowledgeBaseModel.findByOrganization({
        organizationId: org.id,
      });

      expect(results).toEqual([]);
    });

    test("filters by search across name and description", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      await KnowledgeBaseModel.create({
        organizationId: org.id,
        name: "Product Docs",
        description: "Release notes and architecture decisions",
      });
      await KnowledgeBaseModel.create({
        organizationId: org.id,
        name: "Support KB",
        description: "Troubleshooting playbooks",
      });

      const nameResults = await KnowledgeBaseModel.findByOrganization({
        organizationId: org.id,
        search: "product",
      });
      const descriptionResults = await KnowledgeBaseModel.findByOrganization({
        organizationId: org.id,
        search: "playbooks",
      });

      expect(nameResults).toHaveLength(1);
      expect(nameResults[0]?.name).toBe("Product Docs");
      expect(descriptionResults).toHaveLength(1);
      expect(descriptionResults[0]?.name).toBe("Support KB");
    });
  });

  describe("update", () => {
    test("updates a knowledge base name", async ({
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id, { name: "Original" });

      const updated = await KnowledgeBaseModel.update(kb.id, {
        name: "Updated",
      });

      expect(updated).not.toBeNull();
      expect(updated?.name).toBe("Updated");
    });

    test("updates a knowledge base description", async ({
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);

      const updated = await KnowledgeBaseModel.update(kb.id, {
        description: "New description",
      });

      expect(updated?.description).toBe("New description");
    });

    test("updates status", async ({ makeOrganization, makeKnowledgeBase }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);

      const updated = await KnowledgeBaseModel.update(kb.id, {
        status: "inactive",
      });

      expect(updated?.status).toBe("inactive");
    });

    test("returns null for non-existent id", async () => {
      const updated = await KnowledgeBaseModel.update(
        "00000000-0000-0000-0000-000000000000",
        { name: "Does not exist" },
      );
      expect(updated).toBeNull();
    });
  });

  describe("delete", () => {
    test("deletes a knowledge base", async ({
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);

      await KnowledgeBaseModel.delete(kb.id);

      // Verify record is actually gone (PGlite may not return accurate rowCount)
      const found = await KnowledgeBaseModel.findById(kb.id);
      expect(found).toBeNull();
    });

    test("returns false for non-existent id", async () => {
      const deleted = await KnowledgeBaseModel.delete(
        "00000000-0000-0000-0000-000000000000",
      );
      expect(deleted).toBe(false);
    });
  });

  describe("countByOrganization", () => {
    test("returns the count of knowledge bases in an organization", async ({
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      await makeKnowledgeBase(org.id);
      await makeKnowledgeBase(org.id);
      await makeKnowledgeBase(org.id);

      const count = await KnowledgeBaseModel.countByOrganization({
        organizationId: org.id,
      });
      expect(count).toBe(3);
    });

    test("returns 0 when organization has no knowledge bases", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      const count = await KnowledgeBaseModel.countByOrganization({
        organizationId: org.id,
      });
      expect(count).toBe(0);
    });

    test("does not count knowledge bases from other organizations", async ({
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org1 = await makeOrganization();
      const org2 = await makeOrganization();
      await makeKnowledgeBase(org1.id);
      await makeKnowledgeBase(org1.id);
      await makeKnowledgeBase(org2.id);

      const count = await KnowledgeBaseModel.countByOrganization({
        organizationId: org1.id,
      });
      expect(count).toBe(2);
    });

    test("supports search filtering by name and description", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      await KnowledgeBaseModel.create({
        organizationId: org.id,
        name: "Engineering Handbook",
        description: "Internal runbooks",
      });
      await KnowledgeBaseModel.create({
        organizationId: org.id,
        name: "Sales Playbook",
        description: "Customer objection handling",
      });
      await KnowledgeBaseModel.create({
        organizationId: org.id,
        name: "Unrelated",
        description: "Nothing to see here",
      });

      const nameCount = await KnowledgeBaseModel.countByOrganization({
        organizationId: org.id,
        search: "sales",
      });
      const descriptionCount = await KnowledgeBaseModel.countByOrganization({
        organizationId: org.id,
        search: "runbooks",
      });

      expect(nameCount).toBe(1);
      expect(descriptionCount).toBe(1);
    });
  });

  describe("findListEnrichment", () => {
    test("totals every assigned connector's documents, counting a connector once and keeping that total", async ({
      makeMember,
      makeUser,
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const withoutConnectors = await makeKnowledgeBase(org.id);
      const shown = await makeKnowledgeBaseConnector(kb.id, org.id);
      const unseen = await makeKnowledgeBaseConnector(kb.id, org.id, {
        access: "personal",
      });
      const deleted = await makeKnowledgeBaseConnector(kb.id, org.id);
      for (const connectorId of [shown.id, shown.id, unseen.id, deleted.id]) {
        await KbDocumentModel.create(documentData(connectorId, org.id));
      }
      await KnowledgeBaseConnectorModel.delete(deleted.id);
      const user = await makeUser();
      await makeMember(user.id, org.id);
      const member = await memberReach(user.id, org.id);

      const first = await KnowledgeBaseModel.findListEnrichment({
        knowledgeBaseIds: [kb.id, withoutConnectors.id],
        organizationId: org.id,
        ...member,
      });
      // Unseen and soft-deleted connectors still hold documents of this base.
      expect(first.byId.get(kb.id)?.totalDocsIndexed).toBe(4);
      expect(first.byId.get(withoutConnectors.id)?.totalDocsIndexed).toBe(0);
      expect(first.byId.get(kb.id)?.connectors.map((c) => c.id)).toEqual([
        shown.id,
      ]);
      expect(first.firstCounts).toEqual(
        new Map([
          [shown.id, 2],
          [unseen.id, 1],
          [deleted.id, 1],
        ]),
      );

      await KbConnectorDocumentCountModel.storeFirstCounts(first.firstCounts);
      await KbDocumentModel.create(documentData(shown.id, org.id));
      const second = await KnowledgeBaseModel.findListEnrichment({
        knowledgeBaseIds: [kb.id],
        organizationId: org.id,
        ...member,
      });
      expect(second.byId.get(kb.id)?.totalDocsIndexed).toBe(4);
      expect(second.firstCounts.size).toBe(0);
    });

    test("lists the live agents of its organization, its labels and its creator", async ({
      makeMember,
      makeOrganization,
      makeAgent,
      makeKnowledgeBase,
      makeServiceAccount,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const otherOrg = await makeOrganization();
      const author = await makeUser();
      const account = await makeServiceAccount(org.id);
      const byUser = await makeKnowledgeBase(org.id, { createdBy: author.id });
      const byAccount = await KnowledgeBaseModel.create({
        organizationId: org.id,
        name: "Made by an account",
        createdBy: CreatedByModel.id(
          { createdByServiceAccountId: account.id },
          null,
        ),
      });
      const first = await makeAgent({ organizationId: org.id, name: "First" });
      const second = await makeAgent({
        organizationId: org.id,
        name: "Second",
      });
      const removed = await makeAgent({ organizationId: org.id });
      const elsewhere = await makeAgent({ organizationId: otherOrg.id });
      for (const agent of [first, second, removed, elsewhere]) {
        await AgentKnowledgeBaseModel.assign(agent.id, byUser.id);
      }
      await AgentModel.delete(removed.id);
      const viewerUser = await makeUser();
      await makeMember(viewerUser.id, org.id);
      await KnowledgeBaseLabelModel.syncLabels(byUser.id, [
        { key: "team", value: "search" },
        { key: "env", value: "prod" },
      ]);

      const { byId } = await KnowledgeBaseModel.findListEnrichment({
        knowledgeBaseIds: [byUser.id, byAccount.id],
        organizationId: org.id,
        ...(await memberReach(viewerUser.id, org.id)),
      });

      // The test transaction gives every assignment the same created_at, so
      // the order is not asserted.
      expect(byId.get(byUser.id)?.assignedAgents).toHaveLength(2);
      expect(byId.get(byUser.id)?.assignedAgents).toEqual(
        expect.arrayContaining([
          { id: first.id, name: "First", agentType: first.agentType },
          { id: second.id, name: "Second", agentType: second.agentType },
        ]),
      );
      expect(byId.get(byUser.id)?.labels.map((l) => l.key)).toEqual([
        "env",
        "team",
      ]);
      expect(byId.get(byUser.id)?.createdBy).toEqual({
        id: author.id,
        name: author.name,
        email: author.email,
      });
      expect(byId.get(byAccount.id)?.createdBy).toMatchObject({
        name: account.name,
        type: "service_account",
      });
    });

    test("counts the assigned agents by the same rule whether or not it lists them", async ({
      makeAgent,
      makeKnowledgeBase,
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const otherOrg = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const live = await makeAgent({ organizationId: org.id });
      const removed = await makeAgent({ organizationId: org.id });
      const elsewhere = await makeAgent({ organizationId: otherOrg.id });
      for (const agent of [live, removed, elsewhere]) {
        await AgentKnowledgeBaseModel.assign(agent.id, kb.id);
      }
      await AgentModel.delete(removed.id);
      const read = (includeAssignedAgents: boolean) =>
        KnowledgeBaseModel.findListEnrichment({
          knowledgeBaseIds: [kb.id],
          organizationId: org.id,
          canReadAll: true,
          includeAssignedAgents,
        });

      const listed = (await read(true)).byId.get(kb.id);
      const counted = (await read(false)).byId.get(kb.id);

      expect(listed?.assignedAgents.map((agent) => agent.id)).toEqual([
        live.id,
      ]);
      expect(listed?.assignedAgentCount).toBe(1);
      expect(counted?.assignedAgents).toEqual([]);
      expect(counted?.assignedAgentCount).toBe(1);
    });

    test("reads only the creator for the trash view", async ({
      makeOrganization,
      makeAgent,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const author = await makeUser();
      const kb = await makeKnowledgeBase(org.id, { createdBy: author.id });
      await makeKnowledgeBaseConnector(kb.id, org.id);
      const agent = await makeAgent({ organizationId: org.id });
      await AgentKnowledgeBaseModel.assign(agent.id, kb.id);

      const { byId, firstCounts } = await KnowledgeBaseModel.findListEnrichment(
        {
          knowledgeBaseIds: [kb.id],
          organizationId: org.id,
          canReadAll: true,
          identityOnly: true,
        },
      );

      expect(byId.get(kb.id)).toEqual({
        createdBy: { id: author.id, name: author.name, email: author.email },
        connectors: [],
        totalDocsIndexed: 0,
        assignedAgents: [],
        assignedAgentCount: 0,
        labels: [],
      });
      expect(firstCounts.size).toBe(0);
    });
  });
});

/** A plain member's reach, as the list route passes it. */
async function memberReach(userId: string, organizationId: string) {
  return {
    canReadAll: false,
    viewerUserId: userId,
    viewerTeamIds: [],
    viewerPrincipal: await ResourcePermissionSubjectModel.resolvePrincipal({
      userId,
      organizationId,
    }),
  };
}

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

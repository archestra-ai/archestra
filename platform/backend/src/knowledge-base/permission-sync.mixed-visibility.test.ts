// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

//
// Mixed-visibility regressions for the container-ACL model: org-wide and
// team-scoped connectors must keep their exact pre-container behavior — same
// tokens, same query results, untouched by permission passes — and the
// visibility-switch lifecycle must convert cleanly in both directions.
import { vi } from "vitest";
import type { AclEntry, DocumentPermissions } from "@/types";

const { getConnector } = vi.hoisted(() => ({ getConnector: vi.fn() }));
vi.mock("@/knowledge-base/connectors/registry", () => ({ getConnector }));
vi.mock("@/knowledge-base/connector-credentials", () => ({
  resolveConnectorCredentials: vi.fn().mockResolvedValue({}),
}));
vi.mock("@/cache-manager");

import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { buildContainerToken } from "@/knowledge-base/acl-tokens";
import { permissionSyncService } from "@/knowledge-base/permission-sync";
import { knowledgeSourceAccessControlService } from "@/knowledge-base/source-access-control";
import { KbChunkModel, KnowledgeBaseConnectorModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import type { KnowledgeSourceVisibility } from "@/types";

const DIMENSIONS = 384;
const EMBEDDING = Array.from({ length: DIMENSIONS }, () => 0.1);

function fakeConnector(params: {
  containerKey: string;
  permissions: DocumentPermissions;
  sourceIds: string[];
}) {
  return {
    supportsPermissionSync: true,
    async *syncPermissionSnapshot() {
      yield {
        kind: "container" as const,
        containerKey: params.containerKey,
        permissions: params.permissions,
        cursor: params.containerKey,
      };
      for (const sourceId of params.sourceIds) {
        yield {
          kind: "document" as const,
          sourceId,
          containerKey: params.containerKey,
          cursor: params.containerKey,
        };
      }
    },
  };
}

describe("container ACLs preserve org-wide / team-scoped behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permissionSyncService.batchSize = 200;
  });

  async function seedConnectorWithChunk(params: {
    organizationId: string;
    visibility: KnowledgeSourceVisibility;
    teamIds?: string[];
    acl: string[];
    name: string;
  }) {
    const [kb] = await db
      .insert(schema.knowledgeBasesTable)
      .values({ organizationId: params.organizationId, name: params.name })
      .returning();
    const [connector] = await db
      .insert(schema.knowledgeBaseConnectorsTable)
      .values({
        organizationId: params.organizationId,
        name: params.name,
        connectorType: "github",
        visibility: params.visibility,
        teamIds: params.teamIds ?? [],
        config: {
          type: "github",
          githubUrl: "https://api.github.com",
          owner: "o",
          repos: ["r"],
        },
      })
      .returning();
    await db.insert(schema.knowledgeBaseConnectorAssignmentsTable).values({
      connectorId: connector.id,
      knowledgeBaseId: kb.id,
    });
    const [doc] = await db
      .insert(schema.kbDocumentsTable)
      .values({
        organizationId: params.organizationId,
        connectorId: connector.id,
        sourceId: `${params.name}-doc`,
        title: params.name,
        content: "body",
        contentHash: `hash-${params.name}`,
        acl: params.acl,
        embeddingStatus: "completed",
      })
      .returning();
    await db.insert(schema.kbChunksTable).values({
      documentId: doc.id,
      content: "body",
      chunkIndex: 0,
      embedding384: EMBEDDING,
      acl: params.acl,
    });
    return { connector, doc };
  }

  const searchTitles = async (params: {
    connectorIds: string[];
    userAcl: AclEntry[];
  }) =>
    (
      await KbChunkModel.vectorSearch({
        connectorIds: params.connectorIds,
        queryEmbedding: EMBEDDING,
        dimensions: DIMENSIONS,
        userAcl: params.userAcl,
        bypassAcl: false,
      })
    )
      .map((chunk) => chunk.title)
      .sort();

  const docAcl = async (id: string) =>
    (
      await db
        .select({ acl: schema.kbDocumentsTable.acl })
        .from(schema.kbDocumentsTable)
        .where(eq(schema.kbDocumentsTable.id, id))
    )[0]?.acl;

  test("one search spanning all three visibility modes matches each mode's own tokens", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const orgWide = await seedConnectorWithChunk({
      organizationId: org.id,
      visibility: "org-wide",
      acl: ["org:*"],
      name: "org-conn",
    });
    const teamScoped = await seedConnectorWithChunk({
      organizationId: org.id,
      visibility: "team-scoped",
      teamIds: ["team-1"],
      acl: ["team:team-1"],
      name: "team-conn",
    });
    const autoSync = await seedConnectorWithChunk({
      organizationId: org.id,
      visibility: "auto-sync-permissions",
      acl: [],
      name: "auto-conn",
    });
    vi.mocked(getConnector).mockReturnValue(
      fakeConnector({
        containerKey: "repo:o/r",
        permissions: { users: ["alice@example.com"] },
        sourceIds: ["auto-conn-doc"],
      }),
    );
    const pass = await permissionSyncService.executePass(autoSync.connector.id);
    expect(pass.status).toBe("success");

    const connectorIds = [
      orgWide.connector.id,
      teamScoped.connector.id,
      autoSync.connector.id,
    ];
    const autoToken = buildContainerToken({
      connectorId: autoSync.connector.id,
      containerKey: "repo:o/r",
    });

    // Team member with container access: everything.
    expect(
      await searchTitles({
        connectorIds,
        userAcl: [
          "org:*",
          "user_email:alice@example.com",
          "team:team-1",
          autoToken,
        ],
      }),
    ).toEqual(["auto-conn", "org-conn", "team-conn"]);
    // No team, no container: org-wide only.
    expect(
      await searchTitles({
        connectorIds,
        userAcl: ["org:*", "user_email:bob@example.com"],
      }),
    ).toEqual(["org-conn"]);
    // Team but no container access: org + team.
    expect(
      await searchTitles({
        connectorIds,
        userAcl: ["org:*", "user_email:bob@example.com", "team:team-1"],
      }),
    ).toEqual(["org-conn", "team-conn"]);

    // The permission pass never touched the org/team connectors' documents.
    expect(await docAcl(orgWide.doc.id)).toEqual(["org:*"]);
    expect(await docAcl(teamScoped.doc.id)).toEqual(["team:team-1"]);
  });

  test("visibility switch lifecycle: auto-sync → org-wide restores org tokens and drops container rows; switching back re-adopts", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const { connector, doc } = await seedConnectorWithChunk({
      organizationId: org.id,
      visibility: "auto-sync-permissions",
      acl: [],
      name: "switcher",
    });
    vi.mocked(getConnector).mockReturnValue(
      fakeConnector({
        containerKey: "repo:o/r",
        permissions: { users: ["alice@example.com"] },
        sourceIds: ["switcher-doc"],
      }),
    );
    await permissionSyncService.executePass(connector.id);
    const token = buildContainerToken({
      connectorId: connector.id,
      containerKey: "repo:o/r",
    });
    expect(await docAcl(doc.id)).toEqual([token]);
    // A membership snapshot row, as a group-syncing pass would leave behind.
    await db.insert(schema.kbExternalUserGroupsTable).values({
      organizationId: org.id,
      connectorId: connector.id,
      connectorType: "github",
      groupId: "team-x",
      externalAccountId: "acc-1",
      memberEmail: "alice@example.com",
    });

    // ---- Switch AWAY from auto-sync (route flow: update + epoch bump +
    // refresh) — docs get the org-wide token, container and group-membership
    // rows are dropped. ----
    await KnowledgeBaseConnectorModel.update(connector.id, {
      visibility: "org-wide",
    });
    await KnowledgeBaseConnectorModel.bumpAclConfigEpoch(connector.id);
    await knowledgeSourceAccessControlService.refreshConnectorDocumentAccessControlLists(
      connector.id,
    );

    expect(await docAcl(doc.id)).toEqual(["org:*"]);
    const containerRows = await db
      .select()
      .from(schema.kbContainerAclsTable)
      .where(eq(schema.kbContainerAclsTable.connectorId, connector.id));
    expect(containerRows).toHaveLength(0);
    const groupRows = await db
      .select()
      .from(schema.kbExternalUserGroupsTable)
      .where(eq(schema.kbExternalUserGroupsTable.connectorId, connector.id));
    expect(groupRows).toHaveLength(0);

    // ---- Switch BACK to auto-sync — the next pass re-adopts the corpus. ----
    await KnowledgeBaseConnectorModel.update(connector.id, {
      visibility: "auto-sync-permissions",
    });
    await KnowledgeBaseConnectorModel.bumpAclConfigEpoch(connector.id);
    await knowledgeSourceAccessControlService.refreshConnectorDocumentAccessControlLists(
      connector.id,
    );
    const pass = await permissionSyncService.executePass(connector.id);
    expect(pass.status).toBe("success");

    expect(await docAcl(doc.id)).toEqual([token]);
  });
});

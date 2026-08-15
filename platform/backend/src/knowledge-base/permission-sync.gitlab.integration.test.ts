// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

//
// End-to-end permission scenario for the GitLab connector, exercised through
// the REAL machinery against a real database — the GitLab counterpart of
// permission-sync.integration.test.ts:
//   - the real permission-sync pass (permissionSyncService.executePass) with
//     the real @gitbeaker/rest client, mocked at the WIRE (MSW), as the
//     connector unit tests do,
//   - the real query-time ACL construction (buildUserAccessControlList +
//     KbExternalUserGroupModel) and the real `acl ?| ARRAY[...]` chunk filter
//     (KbChunkModel.vectorSearch) that `query_knowledge_sources` enforces.
//
// Scenario: a private project whose only Reporter+ member is one user — the
// member gets the chunk (via the project's roster group), another user does
// not, an admin bypasses; then the member list becomes unreadable upstream,
// the pass re-runs, and the project fail-closes (empty roster, no re-embed).
//
// This is a no-browser data flow, so per the repo's e2e guidance (#6155) it
// lives in the backend suite rather than a Playwright spec.
import { HttpResponse, http } from "msw";
import { vi } from "vitest";

const mockGetSecret = vi.fn();
vi.mock("@/secrets-manager", () => ({
  secretManager: () => ({ getSecret: mockGetSecret }),
}));

import db, { schema } from "@/database";
import {
  buildUserAccessControlList,
  permissionSyncService,
} from "@/knowledge-base";
import { buildContainerToken } from "@/knowledge-base/acl-tokens";
import { findAccessTokensForUserCached } from "@/knowledge-base/group-token-cache";
import { KbChunkModel, KbDocumentModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import type { AclEntry } from "@/types";

const GL = "https://gitlab.com";
const PROJECT_PATH = "my-group/private-project";
const CONTAINER_KEY = `project:${PROJECT_PATH}`;
const GROUP_TOKEN = `group:gitlab_gitlab.com//${PROJECT_PATH}`;
const PERMITTED_EMAIL = "alice@example.com";
const OTHER_EMAIL = "bob@example.com";
// A tiny deterministic embedding so KbChunkModel.vectorSearch has something to
// match; the ACL filter (`acl ?| ARRAY[...]`), not the score, is what we assert.
const DIMENSIONS = 384;
const EMBEDDING = Array.from({ length: DIMENSIONS }, () => 0.1);

const gitlabProject = {
  id: 42,
  name: "private-project",
  path_with_namespace: PROJECT_PATH,
  web_url: `${GL}/${PROJECT_PATH}`,
  visibility: "private",
};

describe("permission-sync end-to-end (GitLab, auto-sync-permissions)", () => {
  const server = useMswServer();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSecret.mockResolvedValue({ secret: { apiToken: "glpat-token" } });
    server.use(
      http.get(`${GL}/api/v4/projects/42`, () =>
        HttpResponse.json(gitlabProject),
      ),
      membersAllHandler([
        {
          id: 7,
          username: "alice",
          name: "Alice",
          access_level: 30,
          state: "active",
          email: PERMITTED_EMAIL,
        },
      ]),
    );
  });

  function membersAllHandler(roster: unknown[] | { status: number }) {
    return http.get(`${GL}/api/v4/projects/42/members/all`, () => {
      if (!Array.isArray(roster)) {
        return HttpResponse.json(
          { message: "error" },
          { status: roster.status },
        );
      }
      return HttpResponse.json(roster);
    });
  }

  async function seedConnectorWithChunk(organizationId: string) {
    const [kb] = await db
      .insert(schema.knowledgeBasesTable)
      .values({ organizationId, name: "KB" })
      .returning();
    const [secret] = await db
      .insert(schema.secretsTable)
      .values({ secret: { apiToken: "glpat-token" } })
      .returning();
    const [connector] = await db
      .insert(schema.knowledgeBaseConnectorsTable)
      .values({
        organizationId,
        name: "GitLab auto-sync",
        connectorType: "gitlab",
        visibility: "auto-sync-permissions",
        secretId: secret.id,
        config: {
          type: "gitlab",
          gitlabUrl: GL,
          projectIds: [42],
        },
      })
      .returning();
    await db.insert(schema.knowledgeBaseConnectorAssignmentsTable).values({
      connectorId: connector.id,
      knowledgeBaseId: kb.id,
    });

    // Content-sync output: a document (fail-closed acl=[]) + one embedded chunk.
    const doc = await KbDocumentModel.create({
      organizationId,
      sourceId: `${PROJECT_PATH}#issue-1`,
      connectorId: connector.id,
      title: "Secret issue",
      content: "confidential contents",
      contentHash: "hash-1",
      acl: [],
      metadata: { project: PROJECT_PATH },
    });
    await KbChunkModel.insertMany([
      {
        documentId: doc.id,
        content: "confidential contents",
        chunkIndex: 0,
        embedding384: EMBEDDING,
        acl: [],
      },
    ]);
    return { connector, doc };
  }

  async function chunkAcl(documentId: string): Promise<string[]> {
    const chunks = await KbChunkModel.findByDocument(documentId);
    return chunks[0]?.acl ?? [];
  }

  async function userAclFor(params: {
    email: string;
    connectorId: string;
  }): Promise<AclEntry[]> {
    const accessTokens = await findAccessTokensForUserCached({
      memberEmail: params.email,
      connectorIds: [params.connectorId],
    });
    return buildUserAccessControlList({
      userEmail: params.email,
      teamIds: [],
      groupTokens: accessTokens,
    });
  }

  function queryChunks(params: {
    connectorId: string;
    userAcl: AclEntry[];
    bypassAcl?: boolean;
  }) {
    return KbChunkModel.vectorSearch({
      connectorIds: [params.connectorId],
      queryEmbedding: EMBEDDING,
      dimensions: DIMENSIONS,
      userAcl: params.userAcl,
      bypassAcl: params.bypassAcl ?? false,
    });
  }

  test("a Reporter+ member retrieves the chunk via the roster group; others do not; admin bypasses", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const { connector, doc } = await seedConnectorWithChunk(org.id);

    const result = await permissionSyncService.executePass(connector.id);
    expect(result.status).toBe("success");

    // The document carries its container token; the member grant lives on the
    // container row's audience as the project's roster-group token.
    const containerToken = buildContainerToken({
      connectorId: connector.id,
      containerKey: CONTAINER_KEY,
    });
    expect(await chunkAcl(doc.id)).toEqual([containerToken]);

    const memberAcl = await userAclFor({
      email: PERMITTED_EMAIL,
      connectorId: connector.id,
    });
    expect(memberAcl).toContain(GROUP_TOKEN);
    expect(memberAcl).toContain(containerToken);
    expect(
      await queryChunks({ connectorId: connector.id, userAcl: memberAcl }),
    ).toHaveLength(1);

    // A non-member resolves neither the group nor the container.
    const otherAcl = await userAclFor({
      email: OTHER_EMAIL,
      connectorId: connector.id,
    });
    expect(
      await queryChunks({ connectorId: connector.id, userAcl: otherAcl }),
    ).toHaveLength(0);

    // An admin (bypassAcl) sees the chunk regardless.
    expect(
      await queryChunks({
        connectorId: connector.id,
        userAcl: [],
        bypassAcl: true,
      }),
    ).toHaveLength(1);
  });

  test("an unreadable member list fail-closes the project on the next pass without re-embedding", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const { connector, doc } = await seedConnectorWithChunk(org.id);

    const first = await permissionSyncService.executePass(connector.id);
    expect(first.status).toBe("success");
    const memberAcl = await userAclFor({
      email: PERMITTED_EMAIL,
      connectorId: connector.id,
    });
    expect(
      await queryChunks({ connectorId: connector.id, userAcl: memberAcl }),
    ).toHaveLength(1);

    // The member list becomes unreadable upstream (500). The re-run replaces
    // the roster with an empty fail-closed membership: the chunk keeps its
    // container token, but nobody resolves the roster group any more.
    server.use(membersAllHandler({ status: 500 }));
    const second = await permissionSyncService.executePass(connector.id);
    expect(second.status).toBe("success");

    const containerToken = buildContainerToken({
      connectorId: connector.id,
      containerKey: CONTAINER_KEY,
    });
    expect(await chunkAcl(doc.id)).toEqual([containerToken]);
    const revokedAcl = await userAclFor({
      email: PERMITTED_EMAIL,
      connectorId: connector.id,
    });
    expect(revokedAcl).not.toContain(GROUP_TOKEN);
    expect(revokedAcl).not.toContain(containerToken);
    expect(
      await queryChunks({ connectorId: connector.id, userAcl: revokedAcl }),
    ).toHaveLength(0);

    // The document content was never re-ingested.
    const refreshed = await KbDocumentModel.findById(doc.id);
    expect(refreshed?.content).toBe("confidential contents");
    expect(refreshed?.contentHash).toBe("hash-1");
  });
});

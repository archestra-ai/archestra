// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

//
// End-to-end permission scenario from the plan's verification section, exercised
// through the REAL machinery against a real database:
//   - the real permission-sync pass (permissionSyncService.executePass) with the
//     real GitHub connector hooks (GitHub mocked at the @octokit/rest boundary,
//     as the connector unit tests do),
//   - the real query-time ACL construction (buildUserAccessControlList +
//     KbExternalUserGroupModel) and the real `acl ?| ARRAY[...]` chunk filter
//     (KbChunkModel.vectorSearch) that `query_knowledge_sources` enforces.
//
// Scenario: a private repo restricted to one collaborator — the permitted user
// gets the chunk, another user does not, an admin bypasses; then access is
// revoked upstream, the pass re-runs, and the chunk fail-closes (no re-embed).
//
// This is a no-browser data flow, so per the repo's e2e guidance (#6155) it
// lives in the backend suite rather than a Playwright spec.
import { vi } from "vitest";

const mockReposGet = vi.fn();
const mockListCollaborators = vi.fn();
const mockReposListTeams = vi.fn();
const mockTeamsList = vi.fn();
const mockListMembersInOrg = vi.fn();
const mockGetByUsername = vi.fn();

vi.mock("@octokit/rest", () => ({
  Octokit: class MockOctokit {
    rest = {
      repos: {
        get: mockReposGet,
        listCollaborators: mockListCollaborators,
        listTeams: mockReposListTeams,
      },
      teams: { list: mockTeamsList, listMembersInOrg: mockListMembersInOrg },
      users: { getByUsername: mockGetByUsername },
    };
  },
}));

const mockGetSecret = vi.fn();
vi.mock("@/secrets-manager", () => ({
  secretManager: () => ({ getSecret: mockGetSecret }),
}));

import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import {
  buildUserAccessControlList,
  permissionSyncService,
} from "@/knowledge-base";
import { buildContainerToken } from "@/knowledge-base/acl-tokens";
import { findAccessTokensForUserCached } from "@/knowledge-base/group-token-cache";
import { KbChunkModel, KbDocumentModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import type { AclEntry } from "@/types";

const REPO = "private-repo";
const OWNER = "test-org";
const REPO_KEY = `${OWNER}/${REPO}`;
const PERMITTED_EMAIL = "alice@example.com";
const OTHER_EMAIL = "bob@example.com";
// A tiny deterministic embedding so KbChunkModel.vectorSearch has something to
// match; the ACL filter (`acl ?| ARRAY[...]`), not the score, is what we assert.
const DIMENSIONS = 384;
const EMBEDDING = Array.from({ length: DIMENSIONS }, () => 0.1);

describe("permission-sync end-to-end (GitHub, auto-sync-permissions)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Credentials for the connector's secret.
    mockGetSecret.mockResolvedValue({ secret: { apiToken: "gh-token" } });
    // getRepos() (per named repo) + resolveRepoAudience() both call repos.get.
    mockReposGet.mockResolvedValue({
      data: { default_branch: "main", private: true },
    });
    // Default audience: the repo is restricted to one collaborator (alice).
    mockListCollaborators.mockResolvedValue({ data: [{ login: "alice" }] });
    mockReposListTeams.mockResolvedValue({ data: [] });
    mockTeamsList.mockResolvedValue({ data: [] });
    mockListMembersInOrg.mockResolvedValue({ data: [] });
    mockGetByUsername.mockImplementation(
      async ({ username }: { username: string }) => ({
        data: { email: `${username}@example.com` },
      }),
    );
  });

  async function seedConnectorWithChunk(organizationId: string) {
    const kb = await makeKb(organizationId);
    const [secret] = await db
      .insert(schema.secretsTable)
      .values({ secret: { apiToken: "gh-token" } })
      .returning();
    const [connector] = await db
      .insert(schema.knowledgeBaseConnectorsTable)
      .values({
        organizationId,
        name: "GitHub auto-sync",
        connectorType: "github",
        visibility: "auto-sync-permissions",
        secretId: secret.id,
        config: {
          type: "github",
          githubUrl: "https://api.github.com",
          owner: OWNER,
          repos: [REPO],
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
      sourceId: `${REPO}#1`,
      connectorId: connector.id,
      title: "Secret issue",
      content: "confidential contents",
      contentHash: "hash-1",
      acl: [],
      metadata: { repo: REPO_KEY },
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

  async function makeKb(organizationId: string) {
    const [kb] = await db
      .insert(schema.knowledgeBasesTable)
      .values({ organizationId, name: "KB" })
      .returning();
    return kb;
  }

  async function chunkAcl(documentId: string): Promise<string[]> {
    const chunks = await KbChunkModel.findByDocument(documentId);
    return chunks[0]?.acl ?? [];
  }

  async function userAclFor(params: {
    email: string;
    connectorId: string;
  }): Promise<AclEntry[]> {
    // Exactly how handleQueryKnowledgeSources builds a querying user's ACL:
    // group tokens from the membership snapshot + container tokens for every
    // container audience the user matches.
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

  test("permitted user retrieves the chunk; others do not; admin bypasses; revoke fail-closes", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const { connector, doc } = await seedConnectorWithChunk(org.id);

    // ---- First pass: assign the repo's docs to the repo container ----
    const first = await permissionSyncService.executePass(connector.id);
    expect(first.status).toBe("success");
    const repoToken = buildContainerToken({
      connectorId: connector.id,
      containerKey: `repo:${REPO_KEY}`,
    });
    expect(await chunkAcl(doc.id)).toEqual([repoToken]);

    const permittedAcl = await userAclFor({
      email: PERMITTED_EMAIL,
      connectorId: connector.id,
    });
    const otherAcl = await userAclFor({
      email: OTHER_EMAIL,
      connectorId: connector.id,
    });

    // The permitted collaborator sees the chunk...
    expect(
      await queryChunks({ connectorId: connector.id, userAcl: permittedAcl }),
    ).toHaveLength(1);
    // ...another user does not...
    expect(
      await queryChunks({ connectorId: connector.id, userAcl: otherAcl }),
    ).toHaveLength(0);
    // ...and an admin (bypassAcl) sees it regardless.
    expect(
      await queryChunks({
        connectorId: connector.id,
        userAcl: [],
        bypassAcl: true,
      }),
    ).toHaveLength(1);

    // ---- Revoke access upstream, re-run the pass (no content change) ----
    mockListCollaborators.mockResolvedValue({ data: [] });
    const second = await permissionSyncService.executePass(connector.id);
    expect(second.status).toBe("success");

    // The revocation is ONE container-row write: the chunk keeps its (now
    // unmatchable) container token, and the user's re-resolved ACL no longer
    // carries it.
    expect(await chunkAcl(doc.id)).toEqual([repoToken]);
    const revokedAcl = await userAclFor({
      email: PERMITTED_EMAIL,
      connectorId: connector.id,
    });
    expect(revokedAcl).not.toContain(repoToken);
    expect(
      await queryChunks({ connectorId: connector.id, userAcl: revokedAcl }),
    ).toHaveLength(0);
    // The document content was never re-ingested.
    const refreshed = await KbDocumentModel.findById(doc.id);
    expect(refreshed?.content).toBe("confidential contents");
    expect(refreshed?.contentHash).toBe("hash-1");
  });

  test("group-based access resolves via the group snapshot at query time", async ({
    makeOrganization,
  }) => {
    // The repo grants access to a team; the team's members are expanded to
    // emails by syncGroups, and a member's query resolves the group token.
    mockListCollaborators.mockResolvedValue({ data: [] });
    mockReposListTeams.mockResolvedValue({ data: [{ slug: "eng" }] });
    mockTeamsList.mockResolvedValue({ data: [{ slug: "eng" }] });
    mockListMembersInOrg.mockResolvedValue({ data: [{ login: "alice" }] });

    const org = await makeOrganization();
    const { connector, doc } = await seedConnectorWithChunk(org.id);

    const result = await permissionSyncService.executePass(connector.id);
    expect(result.status).toBe("success");

    // The document carries its container token; the group grant lives on the
    // container row's audience.
    const repoToken = buildContainerToken({
      connectorId: connector.id,
      containerKey: `repo:${REPO_KEY}`,
    });
    expect(await chunkAcl(doc.id)).toEqual([repoToken]);

    // The team member's snapshot row exists and resolves at query time.
    const rows = await db
      .select()
      .from(schema.kbExternalUserGroupsTable)
      .where(
        and(
          eq(schema.kbExternalUserGroupsTable.connectorId, connector.id),
          eq(schema.kbExternalUserGroupsTable.memberEmail, PERMITTED_EMAIL),
        ),
      );
    expect(rows).toHaveLength(1);

    const memberAcl = await userAclFor({
      email: PERMITTED_EMAIL,
      connectorId: connector.id,
    });
    expect(memberAcl).toContain(`group:github_${OWNER}/eng`);
    // The group membership is what entitles the member to the container.
    expect(memberAcl).toContain(repoToken);
    expect(
      await queryChunks({ connectorId: connector.id, userAcl: memberAcl }),
    ).toHaveLength(1);

    // A non-member does not resolve the group and cannot see the chunk.
    const outsiderAcl = await userAclFor({
      email: OTHER_EMAIL,
      connectorId: connector.id,
    });
    expect(
      await queryChunks({ connectorId: connector.id, userAcl: outsiderAcl }),
    ).toHaveLength(0);
  });
});

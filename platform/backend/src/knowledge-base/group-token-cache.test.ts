// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { vi } from "vitest";

vi.mock("@/cache-manager");

import { KbExternalUserGroupModel, KbMemberOverrideModel } from "@/models";
import { describe, expect, test } from "@/test";
import {
  findAccessTokensForUserCached,
  invalidateGroupTokenCache,
} from "./group-token-cache";

async function grantGroup(params: {
  organizationId: string;
  connectorId: string;
  groupId: string;
  memberEmail: string;
}) {
  await KbExternalUserGroupModel.upsertMany([
    {
      organizationId: params.organizationId,
      connectorId: params.connectorId,
      connectorType: "github",
      groupId: params.groupId,
      externalAccountId: params.memberEmail,
      memberEmail: params.memberEmail,
    },
  ]);
}

describe("findAccessTokensForUserCached", () => {
  test("caches per user — including an EMPTY result — until invalidated", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      visibility: "auto-sync-permissions",
      connectorType: "github",
    });
    const lookup = () =>
      findAccessTokensForUserCached({
        memberEmail: "alice@example.com",
        connectorIds: [connector.id],
      });

    // No memberships yet → empty, and the EMPTY answer is cached.
    expect(await lookup()).toEqual([]);

    await grantGroup({
      organizationId: org.id,
      connectorId: connector.id,
      groupId: "eng",
      memberEmail: "alice@example.com",
    });

    // Still empty: served from cache, not the table.
    expect(await lookup()).toEqual([]);

    // A finished permission sync invalidates → the new grant is visible.
    await invalidateGroupTokenCache();
    expect(await lookup()).toEqual(["group:github_eng"]);
  });

  test("scopes the cache to the connector set", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const a = await makeKnowledgeBaseConnector(kb.id, org.id, {
      visibility: "auto-sync-permissions",
      connectorType: "github",
    });
    const b = await makeKnowledgeBaseConnector(kb.id, org.id, {
      visibility: "auto-sync-permissions",
      connectorType: "github",
    });
    await grantGroup({
      organizationId: org.id,
      connectorId: b.id,
      groupId: "ops",
      memberEmail: "alice@example.com",
    });

    // Warm the cache for connector set [a] (empty).
    expect(
      await findAccessTokensForUserCached({
        memberEmail: "alice@example.com",
        connectorIds: [a.id],
      }),
    ).toEqual([]);

    // A different connector set is a different cache entry — no false share.
    expect(
      await findAccessTokensForUserCached({
        memberEmail: "alice@example.com",
        connectorIds: [a.id, b.id],
      }),
    ).toEqual(["group:github_ops"]);
  });

  test("a manual member override grants the membership's groups even when the upstream email is hidden", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      visibility: "auto-sync-permissions",
      connectorType: "jira",
    });
    const alice = await makeUser({ email: "alice@example.com" });
    // Hidden-email membership: no email join can ever resolve it.
    await KbExternalUserGroupModel.upsertMany([
      {
        organizationId: org.id,
        connectorId: connector.id,
        connectorType: "jira",
        groupId: "eng",
        externalAccountId: "acc-hidden",
        memberEmail: null,
      },
    ]);

    const lookup = () =>
      findAccessTokensForUserCached({
        memberEmail: "alice@example.com",
        userId: alice.id,
        connectorIds: [connector.id],
      });
    expect(await lookup()).toEqual([]);

    await KbMemberOverrideModel.upsert({
      organizationId: org.id,
      connectorId: connector.id,
      externalAccountId: "acc-hidden",
      userId: alice.id,
    });
    // The override editor invalidates, exactly like a finished sync.
    await invalidateGroupTokenCache();
    expect(await lookup()).toEqual(["group:jira_eng"]);

    // Another user does not inherit the mapping.
    const bob = await makeUser({ email: "bob@example.com" });
    expect(
      await findAccessTokensForUserCached({
        memberEmail: "bob@example.com",
        userId: bob.id,
        connectorIds: [connector.id],
      }),
    ).toEqual([]);
  });

  test("an override on an automatically matched account is inert — auto matching always wins", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      visibility: "auto-sync-permissions",
      connectorType: "jira",
    });
    // The upstream account's email resolves to alice, an org member — the
    // account is automatically assigned.
    const alice = await makeUser({ email: "alice@example.com" });
    await makeMember(alice.id, org.id);
    const bob = await makeUser({ email: "bob@example.com" });
    await makeMember(bob.id, org.id);
    await KbExternalUserGroupModel.upsertMany([
      {
        organizationId: org.id,
        connectorId: connector.id,
        connectorType: "jira",
        groupId: "eng",
        externalAccountId: "acc-1",
        memberEmail: "alice@example.com",
      },
    ]);
    // A pre-existing override pointing the account at bob must not grant
    // bob anything while the automatic match holds.
    await KbMemberOverrideModel.upsert({
      organizationId: org.id,
      connectorId: connector.id,
      externalAccountId: "acc-1",
      userId: bob.id,
    });
    await invalidateGroupTokenCache();

    expect(
      await findAccessTokensForUserCached({
        memberEmail: "bob@example.com",
        userId: bob.id,
        connectorIds: [connector.id],
      }),
    ).toEqual([]);
    // The automatic match itself is untouched by the stale override.
    expect(
      await findAccessTokensForUserCached({
        memberEmail: "alice@example.com",
        userId: alice.id,
        connectorIds: [connector.id],
      }),
    ).toEqual(["group:jira_eng"]);
  });

  test("a pathological group count is truncated to the cap (fail-closed under-grant)", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      visibility: "auto-sync-permissions",
      connectorType: "github",
    });
    // One over the 2000-token cap; the query inputs must stay bounded.
    await KbExternalUserGroupModel.upsertMany(
      Array.from({ length: 2001 }, (_, i) => ({
        organizationId: org.id,
        connectorId: connector.id,
        connectorType: "github" as const,
        groupId: `team-${i}`,
        externalAccountId: "alice@example.com",
        memberEmail: "alice@example.com",
      })),
    );

    const tokens = await findAccessTokensForUserCached({
      memberEmail: "alice@example.com",
      connectorIds: [connector.id],
    });

    expect(tokens).toHaveLength(2000);
    expect(tokens.every((token) => token.startsWith("group:github_"))).toBe(
      true,
    );
  });

  test("an empty connector set short-circuits without touching the cache", async () => {
    expect(
      await findAccessTokensForUserCached({
        memberEmail: "alice@example.com",
        connectorIds: [],
      }),
    ).toEqual([]);
  });
});

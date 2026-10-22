// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise

import { sql } from "drizzle-orm";
import { expect, test, vi } from "vitest";
import { cacheManager } from "@/cache-manager";
import db from "@/database";
import { setupTestCacheManager } from "@/test/cache-manager";
import { claimConnectionSetupConversation } from "./connection-setup-conversation-claim";

setupTestCacheManager();

const organizationId = "11111111-1111-4111-8111-111111111111";
const otherOrganizationId = "22222222-2222-4222-8222-222222222222";
const setupId = "33333333-3333-4333-8333-333333333333";
const otherSetupId = "44444444-4444-4444-8444-444444444444";
const ownerId = "55555555-5555-4555-8555-555555555555";
const copierId = "66666666-6666-4666-8666-666666666666";

test("the first native conversation owns the setup until the token expires", async () => {
  // The claim computes a TTL; the cache adds it to a separate clock read.
  vi.spyOn(Date, "now").mockReturnValue(Date.now());
  const expiresAt = Date.now() + 10 * 60 * 1000;
  expect(await claim({ nativeConversationId: ownerId, expiresAt })).toBe(true);
  expect(await claim({ nativeConversationId: copierId, expiresAt })).toBe(
    false,
  );
  expect(await claim({ nativeConversationId: ownerId, expiresAt })).toBe(true);

  const stored = await storedClaim();
  expect(stored?.value).toEqual({ nativeConversationId: ownerId });
  expect(stored?.expires).toBe(expiresAt);
});

test("a second organization or setup does not share the claim", async () => {
  const expiresAt = Date.now() + 10 * 60 * 1000;
  expect(await claim({ nativeConversationId: ownerId, expiresAt })).toBe(true);
  expect(
    await claim({
      organizationId: otherOrganizationId,
      nativeConversationId: copierId,
      expiresAt,
    }),
  ).toBe(true);
  expect(
    await claim({
      setupId: otherSetupId,
      nativeConversationId: copierId,
      expiresAt,
    }),
  ).toBe(true);
  expect(await claim({ nativeConversationId: copierId, expiresAt })).toBe(
    false,
  );
});

test("a window that expires as the lock returns does not exempt", async () => {
  const now = Date.now();
  const expiresAt = now + 60_000;
  const delaySetupId = "88888888-8888-4888-8888-888888888888";
  const realWithLock = cacheManager.withLock.bind(cacheManager);
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  vi.spyOn(cacheManager, "withLock").mockImplementation(
    async (scope, callback) => {
      const claimed = await realWithLock(scope, callback);
      clock.mockReturnValue(expiresAt);
      return claimed;
    },
  );
  try {
    expect(
      await claim({
        setupId: delaySetupId,
        nativeConversationId: ownerId,
        expiresAt,
      }),
    ).toBe(false);
  } finally {
    clock.mockRestore();
  }
  const stored = await storedClaim(delaySetupId);
  expect(stored?.value).toEqual({ nativeConversationId: ownerId });
  expect(stored?.expires).toBe(expiresAt);
});

test("an expired window does not claim and does not write a row", async () => {
  expect(
    await claim({
      nativeConversationId: ownerId,
      expiresAt: Date.now() - 1,
    }),
  ).toBe(false);
  expect(await storedClaim()).toBeUndefined();
});

test("a cache error fails closed", async () => {
  vi.spyOn(cacheManager, "withLock").mockRejectedValueOnce(
    new Error("cache down"),
  );
  expect(
    await claim({
      nativeConversationId: ownerId,
      expiresAt: Date.now() + 60_000,
    }),
  ).toBe(false);
  expect(await storedClaim()).toBeUndefined();
});

test("concurrent first presenters leave exactly one owner", async () => {
  const expiresAt = Date.now() + 10 * 60 * 1000;
  const ids = Array.from(
    { length: 8 },
    (_, index) => `7777777${index}-7777-4777-8777-777777777777`,
  );
  const results = await Promise.all(
    ids.map((nativeConversationId) =>
      claim({ nativeConversationId, expiresAt }),
    ),
  );
  expect(results.filter(Boolean)).toHaveLength(1);
  const winner = ids[results.indexOf(true)];
  expect(winner).toBeDefined();
  expect(await claim({ nativeConversationId: winner, expiresAt })).toBe(true);
  expect(await claim({ nativeConversationId: copierId, expiresAt })).toBe(
    false,
  );
  expect((await storedClaim())?.value).toEqual({
    nativeConversationId: winner,
  });
});

test("the same conversation claiming concurrently stays the owner", async () => {
  const expiresAt = Date.now() + 10 * 60 * 1000;
  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      claim({ nativeConversationId: ownerId, expiresAt }),
    ),
  );
  expect(results.every(Boolean)).toBe(true);
  expect(await claim({ nativeConversationId: copierId, expiresAt })).toBe(
    false,
  );
});

test("parent, affinity, and prompt-cache ids do not claim", async () => {
  const expiresAt = Date.now() + 60_000;
  expect(
    await claimConnectionSetupConversation({
      organizationId,
      setupId,
      expiresAt,
      headers: { "user-agent": "claude-cli/2.1.278 (external, cli)" },
      requestBody: {
        metadata: {
          user_id: JSON.stringify({ parent_session_id: ownerId }),
        },
      },
    }),
  ).toBe(false);
  expect(
    await claimConnectionSetupConversation({
      organizationId,
      setupId,
      expiresAt,
      headers: {
        "user-agent": "codex_cli_rs/0.154.0",
        originator: "codex_cli_rs",
      },
      requestBody: { prompt_cache_key: ownerId },
    }),
  ).toBe(false);
  expect(
    await claimConnectionSetupConversation({
      organizationId,
      setupId,
      expiresAt,
      headers: {
        "user-agent": "opencode",
        "x-session-affinity": ownerId,
      },
      requestBody: {},
    }),
  ).toBe(false);
  expect(await storedClaim()).toBeUndefined();
});

test("claude, codex, and opencode own ids claim, and a bad id does not", async () => {
  const expiresAt = Date.now() + 60_000;
  expect(
    await claimConnectionSetupConversation({
      organizationId,
      setupId,
      expiresAt,
      headers: { "user-agent": "claude-cli/2.1.278 (external, cli)" },
      requestBody: {
        metadata: {
          user_id: JSON.stringify({ session_id: ownerId }),
        },
      },
    }),
  ).toBe(true);
  expect(
    await claimConnectionSetupConversation({
      organizationId,
      setupId: otherSetupId,
      expiresAt,
      headers: {
        "user-agent": "codex_cli_rs/0.154.0",
        "x-codex-turn-metadata": JSON.stringify({ thread_id: ownerId }),
      },
      requestBody: { prompt_cache_key: copierId },
    }),
  ).toBe(true);
  expect((await storedClaim(otherSetupId))?.value).toEqual({
    nativeConversationId: ownerId,
  });
  expect(
    await claimConnectionSetupConversation({
      organizationId: otherOrganizationId,
      setupId,
      expiresAt,
      headers: {
        "user-agent": "opencode",
        "x-opencode-session": ownerId,
      },
      requestBody: {},
    }),
  ).toBe(true);
  expect(
    await claimConnectionSetupConversation({
      organizationId: otherOrganizationId,
      setupId: otherSetupId,
      expiresAt,
      headers: {
        "user-agent": "opencode",
        "x-session-id": copierId,
        "x-session-affinity": copierId,
        "x-opencode-session": ownerId,
      },
      requestBody: {},
    }),
  ).toBe(true);
  expect((await storedClaim(otherSetupId, otherOrganizationId))?.value).toEqual(
    { nativeConversationId: ownerId },
  );
  expect(
    await claimConnectionSetupConversation({
      organizationId,
      setupId: "55555555-5555-4555-8555-555555555550",
      expiresAt,
      headers: {
        "user-agent": "claude-cli/2.1.278 (external, cli)",
        "x-claude-code-session-id": "x".repeat(513),
      },
      requestBody: {},
    }),
  ).toBe(false);
  expect(
    await claimConnectionSetupConversation({
      organizationId,
      setupId: "55555555-5555-4555-8555-555555555551",
      expiresAt,
      headers: {
        "user-agent": "codex_cli_rs/0.154.0",
        "x-codex-turn-metadata": JSON.stringify({ thread_id: ownerId }),
      },
      requestBody: {
        client_metadata: { thread_id: copierId },
      },
    }),
  ).toBe(false);
});

test("Kilo requires its own session id, not affinity, to own a setup", async () => {
  const params = {
    organizationId,
    setupId,
    expiresAt: Date.now() + 60_000,
    requestBody: {},
  };
  const headers = { "user-agent": "kilo/latest/7.8.8/cli" };
  expect(
    await claimConnectionSetupConversation({
      ...params,
      headers: { ...headers, "x-session-affinity": ownerId },
    }),
  ).toBe(false);
  expect(await storedClaim()).toBeUndefined();
  expect(
    await claimConnectionSetupConversation({
      ...params,
      headers: { ...headers, "x-opencode-session": ownerId },
    }),
  ).toBe(true);
  expect(
    await claimConnectionSetupConversation({
      ...params,
      headers: { ...headers, "x-opencode-session": copierId },
    }),
  ).toBe(false);
  expect(
    await claimConnectionSetupConversation({
      ...params,
      headers: { ...headers, "x-opencode-session": ownerId },
    }),
  ).toBe(true);
});

async function claim(params: {
  organizationId?: string;
  setupId?: string;
  nativeConversationId: string;
  expiresAt: number;
}): Promise<boolean> {
  return claimConnectionSetupConversation({
    organizationId: params.organizationId ?? organizationId,
    setupId: params.setupId ?? setupId,
    expiresAt: params.expiresAt,
    headers: {
      "user-agent": "claude-cli/2.1.278 (external, cli)",
      "x-claude-code-session-id": params.nativeConversationId,
    },
    requestBody: {},
  });
}

async function storedClaim(
  id = setupId,
  orgId = organizationId,
): Promise<{ value: unknown; expires: number | undefined } | undefined> {
  const result = await db.execute<{ key: string; value: string }>(sql`
    SELECT key, value FROM keyv_cache
    WHERE key = ${`keyv:connection-setup-conversation-${orgId}:${id}`}
  `);
  const row = result.rows[0];
  if (!row) return undefined;
  const parsed = JSON.parse(row.value) as {
    value?: unknown;
    expires?: number;
  };
  return { value: parsed.value, expires: parsed.expires };
}

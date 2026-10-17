import { TimeInMs } from "@archestra/shared/consts";
import { vi } from "vitest";
import { CacheKey, cacheManager } from "@/cache-manager";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { recordQueries } from "@/test/query-counter";
import type { InteractionResponse } from "@/types";
import InteractionModel from "./interaction";

setupTestCacheManager();

describe("InteractionModel.getUserFilterOptions", () => {
  test("lists the most active users first, capped at the limit", async ({
    makeOrganization,
    makeAgent,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const quiet = await makeUser({ name: "Alpha Quiet" });
    const busy = await makeUser({ name: "Zulu Busy" });
    const middle = await makeUser({ name: "Mike Middle" });
    await seed(agent.id, [quiet.id, busy.id, busy.id, busy.id]);
    await seed(agent.id, [middle.id, middle.id]);

    expect(
      await InteractionModel.getUserFilterOptions({
        organizationId: org.id,
        limit: 2,
      }),
    ).toEqual([
      { id: busy.id, name: "Zulu Busy" },
      { id: middle.id, name: "Mike Middle" },
    ]);
  });

  test("never returns more than the maximum, whatever the requested limit", async ({
    makeOrganization,
    makeAgent,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const users = await Promise.all(
      Array.from({ length: 105 }, (_, i) =>
        makeUser({ name: `User ${String(i).padStart(3, "0")}` }),
      ),
    );
    await seed(
      agent.id,
      users.map((user) => user.id),
    );

    const listed = await InteractionModel.getUserFilterOptions({
      organizationId: org.id,
      limit: 500,
    });
    const searched = await InteractionModel.getUserFilterOptions({
      organizationId: org.id,
      search: "user",
      limit: 500,
    });

    expect(listed).toHaveLength(100);
    expect(searched).toHaveLength(100);
  });

  test("searches names token by token and returns only users with logs in the organization", async ({
    makeOrganization,
    makeAgent,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const other = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const foreignAgent = await makeAgent({ organizationId: other.id });
    const ada = await makeUser({ name: "Lovelace, Ada" });
    const adaNoLogs = await makeUser({ name: "Ada Lovelace Idle" });
    const adaElsewhere = await makeUser({ name: "Ada Lovelace Abroad" });
    const grace = await makeUser({ name: "Grace Hopper" });
    await seed(agent.id, [ada.id, grace.id]);
    await seed(foreignAgent.id, [adaElsewhere.id]);

    const found = await InteractionModel.getUserFilterOptions({
      organizationId: org.id,
      search: "ada lovelace",
      limit: 20,
    });

    expect(found).toEqual([{ id: ada.id, name: "Lovelace, Ada" }]);
    expect(found.map((user) => user.id)).not.toContain(adaNoLogs.id);
  });

  test("matches wildcard characters literally and finds unnamed users by id", async ({
    makeOrganization,
    makeAgent,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const percent = await makeUser({ name: "Load 100% done" });
    const plain = await makeUser({ name: "Load 1000 done" });
    const underscore = await makeUser({ name: "snake_case" });
    const snake = await makeUser({ name: "snakeXcase" });
    const unnamed = await makeUser({ name: "" });
    const named = await makeUser({ name: "Named Person" });
    await seed(agent.id, [
      percent.id,
      plain.id,
      underscore.id,
      snake.id,
      unnamed.id,
      named.id,
    ]);
    const search = (text: string) =>
      InteractionModel.getUserFilterOptions({
        organizationId: org.id,
        search: text,
        limit: 20,
      });

    expect(await search("100%")).toEqual([
      { id: percent.id, name: "Load 100% done" },
    ]);
    expect(await search("snake_case")).toEqual([
      { id: underscore.id, name: "snake_case" },
    ]);
    expect(await search(unnamed.id)).toEqual([{ id: unnamed.id, name: "" }]);
    // A named user is matched by name only, never by id.
    expect(await search(named.id)).toEqual([]);
  });

  test("finds users with logs among many matching users without them, and skips users active only elsewhere", async ({
    makeOrganization,
    makeAgent,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const other = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const foreignAgent = await makeAgent({ organizationId: other.id });
    // Sorted before and after the users with logs, so a search must probe
    // past them in name order.
    await db.insert(schema.usersTable).values(
      Array.from({ length: 300 }, (_, i) => ({
        id: `idle-${i}`,
        name: `Ada ${i % 2 ? "Aaa" : "Zzz"} Idle ${i}`,
        email: `idle-${i}@example.test`,
      })),
    );
    const early = await makeUser({ name: "Ada Bbb Active" });
    const late = await makeUser({ name: "Ada Yyy Active" });
    const heavyElsewhere = await makeUser({ name: "Ada Quixote" });
    await seed(agent.id, [early.id, late.id]);
    await seed(
      foreignAgent.id,
      Array.from({ length: 2_000 }, () => heavyElsewhere.id),
    );
    const search = (text: string, limit = 20) =>
      InteractionModel.getUserFilterOptions({
        organizationId: org.id,
        search: text,
        limit,
      });

    expect(await search("a")).toEqual([
      { id: early.id, name: "Ada Bbb Active" },
      { id: late.id, name: "Ada Yyy Active" },
    ]);
    expect(await search("a", 1)).toEqual([
      { id: early.id, name: "Ada Bbb Active" },
    ]);
    expect(await search("ada yyy")).toEqual([
      { id: late.id, name: "Ada Yyy Active" },
    ]);
    expect(await search("quixote")).toEqual([]);
  });

  test("resolves requested ids only for users with logs in the organization", async ({
    makeOrganization,
    makeAgent,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const other = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const foreignAgent = await makeAgent({ organizationId: other.id });
    const local = await makeUser({ name: "Local" });
    const foreign = await makeUser({ name: "Foreign" });
    await seed(agent.id, [local.id]);
    await seed(foreignAgent.id, [foreign.id]);

    expect(
      await InteractionModel.getUserFilterOptions({
        organizationId: org.id,
        ids: [local.id, foreign.id],
        limit: 20,
      }),
    ).toEqual([{ id: local.id, name: "Local" }]);
  });

  test("keeps each organization's default list separate", async ({
    makeOrganization,
    makeAgent,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const other = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const foreignAgent = await makeAgent({ organizationId: other.id });
    const local = await makeUser({ name: "Local" });
    const foreign = await makeUser({ name: "Foreign" });
    await seed(agent.id, [local.id]);
    await seed(foreignAgent.id, [foreign.id, foreign.id]);

    const list = (organizationId: string) =>
      InteractionModel.getUserFilterOptions({ organizationId, limit: 20 });

    expect(await list(org.id)).toEqual([{ id: local.id, name: "Local" }]);
    expect(await list(other.id)).toEqual([{ id: foreign.id, name: "Foreign" }]);
  });

  test("serves the default list from the cache until it expires", async ({
    makeOrganization,
    makeAgent,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const first = await makeUser({ name: "First" });
    const later = await makeUser({ name: "Later" });
    await seed(agent.id, [first.id]);
    const list = () =>
      InteractionModel.getUserFilterOptions({
        organizationId: org.id,
        limit: 20,
      });
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      expect(await list()).toEqual([{ id: first.id, name: "First" }]);
      await seed(agent.id, [later.id, later.id]);

      clock.mockReturnValue(now + 20 * TimeInMs.Second);
      expect(await list()).toEqual([{ id: first.id, name: "First" }]);
      // Search reads the log directly, so it already sees the new user.
      expect(
        await InteractionModel.getUserFilterOptions({
          organizationId: org.id,
          search: "later",
          limit: 20,
        }),
      ).toEqual([{ id: later.id, name: "Later" }]);

      clock.mockReturnValue(now + 40 * TimeInMs.Second);
      expect(await list()).toEqual([
        { id: later.id, name: "Later" },
        { id: first.id, name: "First" },
      ]);
    } finally {
      clock.mockRestore();
    }
  });

  test("collapses concurrent cache misses for an organization into one load", async ({
    makeOrganization,
    makeAgent,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const other = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const otherAgent = await makeAgent({ organizationId: other.id });
    const user = await makeUser({ name: "Only" });
    await seed(agent.id, [user.id]);
    await seed(otherAgent.id, [user.id]);
    const set = vi.spyOn(cacheManager, "set");

    const results = await Promise.all([
      ...Array.from({ length: 5 }, () =>
        InteractionModel.getUserFilterOptions({
          organizationId: org.id,
          limit: 20,
        }),
      ),
      InteractionModel.getUserFilterOptions({
        organizationId: other.id,
        limit: 20,
      }),
    ]);

    expect(results).toEqual(
      Array.from({ length: 6 }, () => [{ id: user.id, name: "Only" }]),
    );
    // One store per organization: the five concurrent misses shared a load.
    expect(set).toHaveBeenCalledTimes(2);
  });

  test("version churn returns one exact uncached fallback instead of restarting the load", async ({
    makeOrganization,
    makeAgent,
    makeUser,
    makeApp,
  }) => {
    const org = await makeOrganization();
    const other = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const foreignAgent = await makeAgent({ organizationId: other.id });
    const user = await makeUser({ name: "Local" });
    const foreign = await makeUser({ name: "Foreign" });
    await seed(agent.id, [user.id]);
    await seed(foreignAgent.id, [foreign.id, foreign.id]);
    let loads = 0;
    vi.spyOn(cacheManager, "get").mockImplementation(async (key) => {
      if (key.startsWith(CacheKey.InteractionUserOptions)) {
        loads++;
        if (loads <= 3) await makeApp({ organizationId: org.id });
      }
      return undefined;
    });
    const set = vi.spyOn(cacheManager, "set");
    const loaded = await recordQueries(() =>
      InteractionModel.getUserFilterOptions({
        organizationId: org.id,
        limit: 100,
      }),
    );
    expect(loaded.result).toEqual([{ id: user.id, name: user.name }]);
    expect(loads).toBe(1);
    expect(
      loaded.statements.filter((statement) =>
        /\bfrom\s+"?interactions"?\b/i.test(statement),
      ),
    ).toHaveLength(2);
    expect(
      set.mock.calls.some(([key]) =>
        key.startsWith(CacheKey.InteractionUserOptions),
      ),
    ).toBe(false);
  });

  test("still answers when the cache cannot store the list", async ({
    makeOrganization,
    makeAgent,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const user = await makeUser({ name: "Only" });
    await seed(agent.id, [user.id]);
    vi.spyOn(cacheManager, "set").mockRejectedValue(new Error("cache down"));

    expect(
      await InteractionModel.getUserFilterOptions({
        organizationId: org.id,
        limit: 20,
      }),
    ).toEqual([{ id: user.id, name: "Only" }]);
  });
});

// === internals ===

async function seed(profileId: string, userIds: string[]) {
  await db.insert(schema.interactionsTable).values(
    userIds.map((userId) => ({
      profileId,
      userId,
      type: "openai:chatCompletions" as const,
      request: { model: "example", messages: [] },
      response: {
        id: "example",
        object: "chat.completion",
        created: 0,
        model: "example",
        choices: [],
      } as InteractionResponse,
    })),
  );
}

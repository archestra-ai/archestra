import { describe, expect, test, vi } from "vitest";
import { installPoolReadCache, isCacheableStatement } from "./read-cache";

describe("isCacheableStatement", () => {
  test("a SELECT of configuration tables is cacheable", () => {
    expect(
      isCacheableStatement(
        'select "id" from "virtual_api_keys" inner join "member" on "member"."user_id" = "virtual_api_keys"."author_id" where "virtual_api_keys"."token_start" = $1',
      ),
    ).toBe(true);
    expect(
      isCacheableStatement(
        'with "team_ids" as (select "id" from "team") select "id" from "team_ids" join "team_member" on true',
      ),
    ).toBe(true);
  });

  test("writes, locks, logs and functions read the database", () => {
    for (const text of [
      'insert into "agents" ("id") values ($1)',
      'select "id" from "interactions" where "interactions"."id" = $1',
      'select "id" from "agents" where "agents"."id" = $1 for update',
      "select interactions.id from interaction_user_activity_append($1::jsonb) AS interactions",
      'with "moved" as (update "limits" set "limit_value" = 1 returning "id") select "id" from "moved"',
      'select "agents"."id" from "agents" join "interactions" on true',
      "select 1",
    ])
      expect(isCacheableStatement(text), text).toBe(false);
  });
});

describe("installPoolReadCache", () => {
  const selectAgent = {
    text: 'select "id" from "agents" where "agents"."id" = $1',
    rowMode: "array",
  };

  function setup(inScope: boolean) {
    const query = vi.fn(async (..._args: unknown[]) => ({ rows: [["a1"]] }));
    const pool = { query: query as (...args: unknown[]) => unknown };
    const cache = new Map<string, unknown>();
    installPoolReadCache(pool, {
      inScope: () => inScope,
      read: async <T>(key: string, load: () => Promise<T>) => {
        if (!cache.has(key)) cache.set(key, await load());
        return cache.get(key) as T;
      },
    });
    return { pool, query };
  }

  test("in scope, a repeated SELECT reads the database once and each caller gets its own rows", async () => {
    const { pool, query } = setup(true);
    const first = (await pool.query(selectAgent, ["a1"])) as {
      rows: string[][];
    };
    first.rows[0][0] = "changed";
    const second = (await pool.query(selectAgent, ["a1"])) as {
      rows: string[][];
    };
    expect(second.rows).toEqual([["a1"]]);
    expect(query).toHaveBeenCalledTimes(1);
    await pool.query(selectAgent, ["a2"]);
    expect(query).toHaveBeenCalledTimes(2);
  });

  test("out of scope, or for a write, every call reads the database", async () => {
    const outside = setup(false);
    await outside.pool.query(selectAgent, ["a1"]);
    await outside.pool.query(selectAgent, ["a1"]);
    expect(outside.query).toHaveBeenCalledTimes(2);

    const inside = setup(true);
    const insert = 'insert into "agents" ("id") values ($1)';
    await inside.pool.query(insert, ["a1"]);
    await inside.pool.query(insert, ["a1"]);
    expect(inside.query).toHaveBeenCalledTimes(2);
  });
});

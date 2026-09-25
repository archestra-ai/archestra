import { describe, expect, test } from "vitest";
import {
  findMigrationsOlderThanBase,
  findOutOfOrderMigrations,
} from "./check-drizzle-migration-journal";

describe("findOutOfOrderMigrations", () => {
  test("allows the known legacy journal ordering issue", () => {
    expect(
      findOutOfOrderMigrations([
        {
          idx: 253,
          tag: "0253_rename-github-repository-files-flag",
          when: 2000,
        },
        { idx: 254, tag: "0254_black_skin", when: 1000 },
      ]),
    ).toEqual([]);
  });

  test("flags new migrations older than the previous journal entry", () => {
    expect(
      findOutOfOrderMigrations([
        { idx: 260, tag: "0260_repair", when: 3000 },
        { idx: 261, tag: "0261_new_feature", when: 2500 },
      ]),
    ).toEqual([
      {
        previous: { idx: 260, tag: "0260_repair", when: 3000 },
        current: { idx: 261, tag: "0261_new_feature", when: 2500 },
      },
    ]);
  });
});

describe("findMigrationsOlderThanBase", () => {
  const baseEntries = [
    { idx: 483, tag: "0483_shared", when: 3000 },
    { idx: 484, tag: "0484_landed_on_main", when: 5000 },
  ];

  test("flags a branch migration older than the newest entry on main", () => {
    expect(
      findMigrationsOlderThanBase({
        baseEntries,
        entries: [
          { idx: 483, tag: "0483_shared", when: 3000 },
          { idx: 484, tag: "0484_branch_work", when: 4000 },
        ],
      }),
    ).toEqual([
      {
        added: { idx: 484, tag: "0484_branch_work", when: 4000 },
        newestOnBase: { idx: 484, tag: "0484_landed_on_main", when: 5000 },
      },
    ]);
  });

  test("accepts a branch migration newer than everything on main", () => {
    expect(
      findMigrationsOlderThanBase({
        baseEntries,
        entries: [...baseEntries, { idx: 485, tag: "0485_branch", when: 6000 }],
      }),
    ).toEqual([]);
  });

  test("ignores entries main already carries", () => {
    expect(
      findMigrationsOlderThanBase({ baseEntries, entries: baseEntries }),
    ).toEqual([]);
  });

  test("reports nothing when main has no migrations to compare against", () => {
    expect(
      findMigrationsOlderThanBase({
        baseEntries: [],
        entries: [{ idx: 1, tag: "0001_first", when: 10 }],
      }),
    ).toEqual([]);
  });
});

import { describe, expect, test } from "vitest";
import { findOutOfOrderMigrations } from "./check-drizzle-migration-journal";

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

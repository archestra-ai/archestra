import { describe, expect, test } from "vitest";
import {
  isMetadataOnlyEdit,
  METADATA_ONLY_CATALOG_FIELDS,
} from "./catalog-runtime-fields";

describe("isMetadataOnlyEdit", () => {
  const base = {
    name: "github-mcp",
    description: "original",
    serverType: "local" as const,
    localConfig: { command: "node", arguments: ["/srv/index.js"] },
    userConfig: { TOKEN: { type: "string", required: true } },
  };

  test("description-only edit returns true", () => {
    expect(
      isMetadataOnlyEdit(base, { ...base, description: "rewritten" }),
    ).toBe(true);
  });

  test("no change at all returns false", () => {
    // Contract: true means there IS a metadata-only diff to skip for.
    expect(isMetadataOnlyEdit(base, { ...base })).toBe(false);
  });

  test("non-metadata edit returns false", () => {
    expect(
      isMetadataOnlyEdit(base, {
        ...base,
        localConfig: { ...base.localConfig, command: "bun" },
      }),
    ).toBe(false);
  });

  test("mixed metadata + non-metadata edit returns false", () => {
    expect(
      isMetadataOnlyEdit(base, {
        ...base,
        description: "rewritten",
        localConfig: { ...base.localConfig, command: "bun" },
      }),
    ).toBe(false);
  });

  test("non-metadata edit on a field that isn't on prev returns false", () => {
    expect(
      isMetadataOnlyEdit(base, { ...base, oauthConfig: { name: "x" } }),
    ).toBe(false);
  });

  test("updatedAt/createdAt drift doesn't disqualify a description-only edit (backend call-site shape)", () => {
    // `Model.update` bumps `updatedAt` on every write; without IGNORED
    // the predicate would return false for every description-only PUT.
    expect(
      isMetadataOnlyEdit(
        { ...base, updatedAt: new Date("2026-01-01T00:00:00Z") },
        {
          ...base,
          description: "rewritten",
          updatedAt: new Date("2026-01-01T00:00:00.123Z"),
        },
      ),
    ).toBe(true);
  });

  test("DB-only fields on prev (id, organizationId, …) don't disqualify a frontend PATCH-shape next", () => {
    // Frontend passes full DB row vs sparse form payload. Iterating
    // `Object.keys(next)` plus IGNORED keeps absent fields from tripping.
    const itemFromDb = {
      ...base,
      id: "uuid-of-catalog",
      organizationId: "org-1",
      authorId: "user-1",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      labels: [{ key: "env", value: "prod" }],
      teams: [],
      authorName: "Alex",
    };
    const apiDataFromForm = {
      ...base,
      description: "rewritten",
    };
    expect(isMetadataOnlyEdit(itemFromDb, apiDataFromForm)).toBe(true);
  });

  test("derived display fields (authorName, toolCount) don't disqualify a description-only edit", () => {
    // `findChildren` returns list shape (has `toolCount`, lacks
    // `authorName`); `Model.update` returns the opposite. Without
    // IGNORED, every child with an author would auto-reinstall.
    expect(
      isMetadataOnlyEdit(
        { ...base, toolCount: 3, authorName: undefined },
        {
          ...base,
          description: "rewritten",
          toolCount: undefined,
          authorName: "Alice",
        },
      ),
    ).toBe(true);
  });

  test("METADATA_ONLY_CATALOG_FIELDS is the public contract", () => {
    // Tripwire — adding a field here is a behavior change everywhere.
    expect(METADATA_ONLY_CATALOG_FIELDS).toEqual(["description", "labels"]);
  });
});

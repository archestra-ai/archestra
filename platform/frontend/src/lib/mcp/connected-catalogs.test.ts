import { describe, expect, it } from "vitest";
import { getUsableConnectedCatalogIds } from "./connected-catalogs";

const me = "user-me";
const other = "user-other";

describe("getUsableConnectedCatalogIds", () => {
  it("counts the current user's own personal server", () => {
    const result = getUsableConnectedCatalogIds({
      servers: [{ catalogId: "cat_1", scope: "personal", ownerId: me }],
      currentUserId: me,
    });
    expect(result.has("cat_1")).toBe(true);
  });

  it("does NOT count another user's personal server (admin viewing others' installs)", () => {
    const result = getUsableConnectedCatalogIds({
      servers: [{ catalogId: "cat_1", scope: "personal", ownerId: other }],
      currentUserId: me,
    });
    expect(result.has("cat_1")).toBe(false);
  });

  it("counts org-scoped servers regardless of owner", () => {
    const result = getUsableConnectedCatalogIds({
      servers: [{ catalogId: "cat_1", scope: "org", ownerId: other }],
      currentUserId: me,
    });
    expect(result.has("cat_1")).toBe(true);
  });

  it("counts team-scoped servers", () => {
    const result = getUsableConnectedCatalogIds({
      servers: [{ catalogId: "cat_1", scope: "team", ownerId: other }],
      currentUserId: me,
    });
    expect(result.has("cat_1")).toBe(true);
  });

  it("counts a catalog when the user owns one of several servers for it", () => {
    const result = getUsableConnectedCatalogIds({
      servers: [
        { catalogId: "cat_1", scope: "personal", ownerId: other },
        { catalogId: "cat_1", scope: "personal", ownerId: me },
      ],
      currentUserId: me,
    });
    expect(result.has("cat_1")).toBe(true);
  });

  it("ignores servers without a catalog id", () => {
    const result = getUsableConnectedCatalogIds({
      servers: [{ catalogId: null, scope: "org", ownerId: me }],
      currentUserId: me,
    });
    expect(result.size).toBe(0);
  });

  it("excludes personal servers while the session/user id is still unknown", () => {
    const result = getUsableConnectedCatalogIds({
      servers: [
        { catalogId: "cat_personal", scope: "personal", ownerId: me },
        { catalogId: "cat_org", scope: "org", ownerId: other },
      ],
      currentUserId: undefined,
    });
    expect(result.has("cat_personal")).toBe(false);
    expect(result.has("cat_org")).toBe(true);
  });

  it("returns an empty set for missing servers", () => {
    expect(
      getUsableConnectedCatalogIds({ servers: undefined, currentUserId: me })
        .size,
    ).toBe(0);
  });
});

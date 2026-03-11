import { describe, expect, test } from "@/test";
import { buildDocumentAcl, buildUserAcl } from "./acl";

describe("buildDocumentAcl", () => {
  test("returns org:* for org-wide visibility", () => {
    const acl = buildDocumentAcl({
      visibility: "org-wide",
      teamIds: [],
    });
    expect(acl).toEqual(["org:*"]);
  });

  test("ignores teamIds for org-wide visibility", () => {
    const acl = buildDocumentAcl({
      visibility: "org-wide",
      teamIds: ["team-1", "team-2"],
    });
    expect(acl).toEqual(["org:*"]);
  });

  test("returns team entries for team-scoped visibility", () => {
    const acl = buildDocumentAcl({
      visibility: "team-scoped",
      teamIds: ["team-abc", "team-def"],
    });
    expect(acl).toEqual(["team:team-abc", "team:team-def"]);
  });

  test("returns empty array for team-scoped with no teams", () => {
    const acl = buildDocumentAcl({
      visibility: "team-scoped",
      teamIds: [],
    });
    expect(acl).toEqual([]);
  });

  test("auto-sync-permissions with public flag returns org:*", () => {
    const acl = buildDocumentAcl({
      visibility: "auto-sync-permissions",
      teamIds: [],
      permissions: { isPublic: true },
    });
    expect(acl).toContain("org:*");
  });

  test("auto-sync-permissions extracts user emails", () => {
    const acl = buildDocumentAcl({
      visibility: "auto-sync-permissions",
      teamIds: [],
      permissions: {
        users: ["alice@example.com", "bob@example.com"],
      },
    });
    expect(acl).toEqual([
      "user_email:alice@example.com",
      "user_email:bob@example.com",
    ]);
  });

  test("auto-sync-permissions extracts groups", () => {
    const acl = buildDocumentAcl({
      visibility: "auto-sync-permissions",
      teamIds: [],
      permissions: {
        groups: ["eng-team", "product-team"],
      },
    });
    expect(acl).toEqual(["group:eng-team", "group:product-team"]);
  });

  test("auto-sync-permissions combines all permission types", () => {
    const acl = buildDocumentAcl({
      visibility: "auto-sync-permissions",
      teamIds: [],
      permissions: {
        isPublic: true,
        users: ["user@example.com"],
        groups: ["group-1"],
      },
    });
    expect(acl).toEqual([
      "org:*",
      "user_email:user@example.com",
      "group:group-1",
    ]);
  });

  test("auto-sync-permissions falls back to org:* when no permissions", () => {
    const acl = buildDocumentAcl({
      visibility: "auto-sync-permissions",
      teamIds: [],
      permissions: {},
    });
    expect(acl).toEqual(["org:*"]);
  });

  test("auto-sync-permissions falls back to org:* when permissions undefined", () => {
    const acl = buildDocumentAcl({
      visibility: "auto-sync-permissions",
      teamIds: [],
    });
    expect(acl).toEqual(["org:*"]);
  });
});

describe("buildUserAcl", () => {
  test("includes org:* for org-wide visibility", () => {
    const acl = buildUserAcl({
      userEmail: "user@example.com",
      teamIds: [],
      visibility: "org-wide",
    });
    expect(acl).toContain("org:*");
    expect(acl).toContain("user_email:user@example.com");
  });

  test("does not include org:* for team-scoped visibility", () => {
    const acl = buildUserAcl({
      userEmail: "user@example.com",
      teamIds: ["team-1"],
      visibility: "team-scoped",
    });
    expect(acl).not.toContain("org:*");
    expect(acl).toContain("user_email:user@example.com");
    expect(acl).toContain("team:team-1");
  });

  test("includes all team entries", () => {
    const acl = buildUserAcl({
      userEmail: "user@example.com",
      teamIds: ["team-a", "team-b", "team-c"],
      visibility: "team-scoped",
    });
    expect(acl).toContain("team:team-a");
    expect(acl).toContain("team:team-b");
    expect(acl).toContain("team:team-c");
  });

  test("always includes user email", () => {
    const acl = buildUserAcl({
      userEmail: "admin@corp.com",
      teamIds: [],
      visibility: "org-wide",
    });
    expect(acl).toContain("user_email:admin@corp.com");
  });

  test("auto-sync-permissions does not include org:*", () => {
    const acl = buildUserAcl({
      userEmail: "user@example.com",
      teamIds: ["team-1"],
      visibility: "auto-sync-permissions",
    });
    expect(acl).not.toContain("org:*");
    expect(acl).toContain("user_email:user@example.com");
    expect(acl).toContain("team:team-1");
  });
});

// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { describe, expect, test } from "@/test";
import {
  type P4GroupSpec,
  type P4ProtectionLine,
  P4ProtectionsEvaluator,
  parseGroupSpecRecord,
  parseProtectsRecords,
} from "./p4-protections";

function line(partial: Partial<P4ProtectionLine>): P4ProtectionLine {
  return {
    access: "read",
    holderKind: "user",
    holderName: "*",
    host: "*",
    path: "//depot/...",
    isExclusion: false,
    ...partial,
  };
}

function evaluator(params: {
  lines: P4ProtectionLine[];
  groups?: P4GroupSpec[];
  caseInsensitive?: boolean;
}): P4ProtectionsEvaluator {
  return new P4ProtectionsEvaluator({
    lines: params.lines,
    groups: params.groups ?? [],
    caseInsensitive: params.caseInsensitive ?? false,
  });
}

function canRead(
  e: P4ProtectionsEvaluator,
  username: string,
  path: string,
): boolean {
  return e.userCanRead(username, e.matchingLines(path));
}

describe("parseProtectsRecords", () => {
  test("parses user, group, and exclusion variants", () => {
    const lines = parseProtectsRecords([
      { perm: "write", user: "alice", host: "*", depotFile: "//depot/..." },
      {
        perm: "read",
        user: "devs",
        isgroup: "",
        host: "*",
        depotFile: "//depot/docs/...",
      },
      { perm: "read", group: "ops", host: "*", depotFile: "//ops/..." },
      {
        perm: "write",
        user: "bob",
        host: "*",
        depotFile: "-//depot/secret/...",
      },
      {
        perm: "list",
        user: "eve",
        host: "*",
        depotFile: "//depot/x/...",
        unmap: "",
      },
    ]);
    expect(lines.map((l) => l.holderKind)).toEqual([
      "user",
      "group",
      "group",
      "user",
      "user",
    ]);
    expect(lines[3]).toMatchObject({
      isExclusion: true,
      path: "//depot/secret/...",
    });
    expect(lines[4].isExclusion).toBe(true);
  });

  test("a record missing essentials fails the parse (fail-closed)", () => {
    expect(() => parseProtectsRecords([{ perm: "read", host: "*" }])).toThrow(
      /Malformed protections record/,
    );
  });
});

describe("parseGroupSpecRecord", () => {
  test("collects indexed users and subgroups, ignores owners", () => {
    const spec = parseGroupSpecRecord({
      Group: "devs",
      Owners0: "boss",
      Users0: "alice",
      Users1: "bob",
      Subgroups0: "contractors",
    });
    expect(spec).toEqual({
      name: "devs",
      users: ["alice", "bob"],
      subgroups: ["contractors"],
    });
  });

  test("missing Group field throws", () => {
    expect(() => parseGroupSpecRecord({ Users0: "x" })).toThrow(
      /missing Group/,
    );
  });
});

describe("path matching", () => {
  test("... spans segments, * stays within one", () => {
    const e = evaluator({
      lines: [
        line({ holderName: "deep", path: "//depot/docs/..." }),
        line({ holderName: "flat", path: "//depot/docs/*.md" }),
      ],
    });
    expect(canRead(e, "deep", "//depot/docs/a/b/c.md")).toBe(true);
    expect(canRead(e, "flat", "//depot/docs/readme.md")).toBe(true);
    expect(canRead(e, "flat", "//depot/docs/sub/readme.md")).toBe(false);
    expect(canRead(e, "deep", "//depot/other/a.md")).toBe(false);
  });

  test("regex metacharacters in paths are literal", () => {
    const e = evaluator({
      lines: [line({ holderName: "u", path: "//depot/a+b/..." })],
    });
    expect(canRead(e, "u", "//depot/a+b/x.md")).toBe(true);
    expect(canRead(e, "u", "//depot/aab/x.md")).toBe(false);
  });

  test("case-insensitive servers fold paths and names", () => {
    const e = evaluator({
      lines: [line({ holderName: "Alice", path: "//Depot/Docs/..." })],
      caseInsensitive: true,
    });
    expect(canRead(e, "alice", "//depot/docs/x.md")).toBe(true);
  });
});

describe("access evaluation", () => {
  test("levels include everything below them; list alone is not read", () => {
    const e = evaluator({
      lines: [
        line({ holderName: "writer", access: "write" }),
        line({ holderName: "lister", access: "list" }),
        line({ holderName: "reviewer", access: "review" }),
        line({ holderName: "superuser", access: "super" }),
      ],
    });
    expect(canRead(e, "writer", "//depot/x.md")).toBe(true);
    expect(canRead(e, "lister", "//depot/x.md")).toBe(false);
    expect(canRead(e, "reviewer", "//depot/x.md")).toBe(true);
    expect(canRead(e, "superuser", "//depot/x.md")).toBe(true);
  });

  test("a plain exclusion wipes everything accumulated; later lines re-grant", () => {
    const lines = [
      line({ holderName: "alice", access: "write" }),
      line({
        holderName: "alice",
        access: "list",
        path: "//depot/...",
        isExclusion: true,
      }),
      line({ holderName: "bob", access: "write" }),
      line({
        holderName: "bob",
        access: "list",
        path: "//depot/...",
        isExclusion: true,
      }),
      line({ holderName: "bob", access: "read" }),
    ];
    const e = evaluator({ lines });
    // The exclusion's own access level is irrelevant — all access is denied.
    expect(canRead(e, "alice", "//depot/x.md")).toBe(false);
    // A grant BELOW the exclusion re-grants.
    expect(canRead(e, "bob", "//depot/x.md")).toBe(true);
  });

  test("=read exclusion removes exactly the read right from a write grant", () => {
    const e = evaluator({
      lines: [
        line({ holderName: "alice", access: "write" }),
        line({ holderName: "alice", access: "=read", isExclusion: true }),
      ],
    });
    expect(canRead(e, "alice", "//depot/x.md")).toBe(false);
  });

  test("=read grant confers exactly read", () => {
    const e = evaluator({
      lines: [line({ holderName: "alice", access: "=read" })],
    });
    expect(canRead(e, "alice", "//depot/x.md")).toBe(true);
  });

  test("unknown access modes grant nothing (fail-closed)", () => {
    const e = evaluator({
      lines: [line({ holderName: "alice", access: "owner" })],
    });
    expect(canRead(e, "alice", "//depot/x.md")).toBe(false);
  });

  test("the * user wildcard applies to every user", () => {
    const e = evaluator({ lines: [line({ holderName: "*" })] });
    expect(canRead(e, "anyone", "//depot/x.md")).toBe(true);
  });

  test("host-restricted lines do not participate (grants nor exclusions)", () => {
    const e = evaluator({
      lines: [
        line({ holderName: "alice", host: "10.0.0.1", access: "write" }),
        line({ holderName: "bob", access: "write" }),
        line({
          holderName: "bob",
          host: "10.0.0.1",
          isExclusion: true,
          access: "write",
        }),
      ],
    });
    // Alice's only grant is host-bound: not in the audience.
    expect(canRead(e, "alice", "//depot/x.md")).toBe(false);
    // Bob's exclusion is host-bound: his all-hosts grant stands.
    expect(canRead(e, "bob", "//depot/x.md")).toBe(true);
  });
});

describe("groups", () => {
  const groups: P4GroupSpec[] = [
    { name: "devs", users: ["alice"], subgroups: ["contractors"] },
    { name: "contractors", users: ["carol"], subgroups: [] },
    // Cycle: must not hang.
    { name: "a", users: ["dave"], subgroups: ["b"] },
    { name: "b", users: [], subgroups: ["a"] },
  ];

  test("group lines match members, transitively through subgroups", () => {
    const e = evaluator({
      lines: [
        line({ holderKind: "group", holderName: "devs", access: "read" }),
      ],
      groups,
    });
    expect(canRead(e, "alice", "//depot/x.md")).toBe(true);
    expect(canRead(e, "carol", "//depot/x.md")).toBe(true);
    expect(canRead(e, "mallory", "//depot/x.md")).toBe(false);
  });

  test("subgroup cycles terminate and still resolve members", () => {
    const e = evaluator({
      lines: [line({ holderKind: "group", holderName: "b", access: "read" })],
      groups,
    });
    expect(canRead(e, "dave", "//depot/x.md")).toBe(true);
  });

  test("an exclusion carves one member out of a granted group", () => {
    const e = evaluator({
      lines: [
        line({ holderKind: "group", holderName: "devs", access: "write" }),
        line({ holderName: "carol", isExclusion: true, access: "list" }),
      ],
      groups,
    });
    expect(canRead(e, "alice", "//depot/x.md")).toBe(true);
    expect(canRead(e, "carol", "//depot/x.md")).toBe(false);
  });
});

describe("signatures and audiences", () => {
  test("audience filters the roster to users with read", () => {
    const e = evaluator({
      lines: [
        line({ holderName: "alice", access: "write" }),
        line({ holderName: "bob", access: "list" }),
      ],
    });
    const signature = e.matchingLines("//depot/x.md");
    expect(e.audience(["alice", "bob", "carol"], signature)).toEqual(["alice"]);
  });

  test("an empty signature yields an empty audience", () => {
    const e = evaluator({ lines: [] });
    expect(e.audience(["alice"], [])).toEqual([]);
  });

  test("signature keys are content-derived and order-sensitive", () => {
    const a = line({ holderName: "alice", access: "read" });
    const b = line({ holderName: "bob", access: "write" });
    const e = evaluator({ lines: [a, b] });
    expect(e.signatureKey([a, b])).toBe(e.signatureKey([a, b]));
    expect(e.signatureKey([a, b])).not.toBe(e.signatureKey([b, a]));
    expect(e.signatureKey([a])).not.toBe(e.signatureKey([a, b]));
  });

  test("matchingLines excludes host-restricted lines from the signature", () => {
    const e = evaluator({
      lines: [
        line({ holderName: "alice" }),
        line({ holderName: "bob", host: "10.1.1.1" }),
      ],
    });
    const signature = e.matchingLines("//depot/x.md");
    expect(signature).toHaveLength(1);
    expect(signature[0].holderName).toBe("alice");
  });
});

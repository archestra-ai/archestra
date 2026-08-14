// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { vi } from "vitest";
import { beforeEach, describe, expect, test } from "@/test";
import type {
  GroupMembershipYield,
  PermissionSnapshotYield,
  PermissionSyncParams,
  ReadIngestedDocuments,
} from "@/types";

// Boundary mock: the shim service reaches Kubernetes + the shim pod. The fake
// serves canned `p4 -ztag -Mj` records; everything else (evaluator, bucketing,
// audience resolution) is the real connector code under test.
const fakeData: {
  protects: Array<Record<string, unknown>>;
  groups: Record<string, Record<string, unknown>>;
  users: Array<Record<string, unknown>>;
  caseHandling: string;
} = { protects: [], groups: {}, users: [], caseHandling: "sensitive" };

vi.mock("./p4-shim-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./p4-shim-service")>();
  return {
    ...actual,
    getP4ShimConnection: vi.fn(async () => ({
      address: { host: "p4.example.com", port: 1666 },
      client: {
        info: async () => ({ caseHandling: fakeData.caseHandling }),
        protectsAll: async () => fakeData.protects,
        listGroups: async () => Object.keys(fakeData.groups),
        groupSpec: async (name: string) => {
          const spec = fakeData.groups[name];
          if (!spec) throw new Error(`no such group ${name}`);
          return spec;
        },
        listUsers: async () => fakeData.users,
      },
    })),
  };
});

import { PerforceConnector } from "./perforce-connector";

const CONFIG = {
  type: "perforce",
  serverUrl: "https://p4.example.com:8080",
  depotPaths: ["//depot/docs", "//depot/eng"],
  p4Port: "ssl:P4.example.com:1666",
  adminUsername: "svc-archestra",
};

const IDENTITY = {
  connectorId: "22222222-2222-4222-8222-222222222222",
  organizationId: "11111111-1111-4111-8111-111111111111",
  environmentId: null,
  secretId: "33333333-3333-4333-8333-333333333333",
  credentialVersion: "2026-08-14T12:00:00.000Z",
};

const CREDENTIALS = {
  email: "reader",
  apiToken: "content-ticket",
  adminApiKey: "admin-password",
};

const DOCS = [
  {
    sourceId: "//depot/docs/a.md",
    metadata: { depotPath: "//depot/docs/a.md" },
  },
  {
    sourceId: "//depot/docs/private/x.md",
    metadata: { depotPath: "//depot/docs/private/x.md" },
  },
  { sourceId: "//depot/eng/e.md", metadata: { depotPath: "//depot/eng/e.md" } },
];

const readIngestedDocuments: ReadIngestedDocuments = async ({ afterId }) => ({
  documents: afterId ? [] : DOCS,
  nextAfterId: null,
});

function permissionParams(
  overrides?: Partial<PermissionSyncParams>,
): PermissionSyncParams {
  return {
    config: CONFIG,
    credentials: CREDENTIALS,
    identity: IDENTITY,
    cursor: null,
    readIngestedDocuments,
    resolveMappedEmail: (accountId) =>
      accountId === "carol" ? "carol@mapped.example" : null,
    ...overrides,
  };
}

async function collect<T>(generator: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of generator) out.push(item);
  return out;
}

beforeEach(() => {
  fakeData.caseHandling = "sensitive";
  fakeData.protects = [
    { perm: "super", user: "svc-archestra", host: "*", depotFile: "//..." },
    { perm: "read", group: "devs", host: "*", depotFile: "//depot/docs/..." },
    { perm: "write", user: "alice", host: "*", depotFile: "//depot/eng/..." },
    {
      perm: "list",
      user: "bob",
      host: "*",
      depotFile: "//depot/docs/private/...",
      unmap: "",
    },
    { perm: "read", user: "carol", host: "*", depotFile: "//depot/eng/..." },
  ];
  fakeData.groups = {
    devs: { Group: "devs", Users0: "alice", Users1: "bob" },
  };
  fakeData.users = [
    { User: "alice", Email: "alice@example.com", FullName: "Alice A" },
    { User: "bob", Email: "bob@example.com", FullName: "Bob B" },
    { User: "carol", FullName: "Carol C" }, // no upstream email
    { User: "svc-archestra", Email: "svc@example.com", FullName: "Service" },
  ];
});

describe("syncPermissionSnapshot", () => {
  test("partitions documents by protection signature and emits per-user audiences", async () => {
    const connector = new PerforceConnector();
    const yields = await collect(
      connector.syncPermissionSnapshot(permissionParams()),
    );

    const containers = yields.filter(
      (y): y is Extract<PermissionSnapshotYield, { kind: "container" }> =>
        y.kind === "container",
    );
    const documents = yields.filter(
      (y): y is Extract<PermissionSnapshotYield, { kind: "document" }> =>
        y.kind === "document",
    );

    // Top-level anchors, ascending, audience-less.
    const topLevel = containers.filter(
      (c) => !c.containerKey.includes("/acl:"),
    );
    expect(topLevel.map((c) => c.containerKey)).toEqual([
      "depot://depot/docs",
      "depot://depot/eng",
    ]);
    expect(topLevel.every((c) => !c.permissions.users?.length)).toBe(true);

    // Every document lands in a nested signature container of its top-level.
    expect(documents).toHaveLength(3);
    const byDoc = new Map(documents.map((d) => [d.sourceId, d.containerKey]));
    for (const [sourceId, containerKey] of byDoc) {
      expect(containerKey).toMatch(
        sourceId.startsWith("//depot/docs")
          ? /^depot:\/\/depot\/docs\/acl:[0-9a-f]{16}$/
          : /^depot:\/\/depot\/eng\/acl:[0-9a-f]{16}$/,
      );
    }
    // The excluded subtree gets a different signature container than its parent.
    expect(byDoc.get("//depot/docs/a.md")).not.toBe(
      byDoc.get("//depot/docs/private/x.md"),
    );

    const audienceOf = (sourceId: string) =>
      containers.find((c) => c.containerKey === byDoc.get(sourceId))
        ?.permissions.users;

    // devs group (alice, bob) + super svc-archestra read the docs tree...
    expect(audienceOf("//depot/docs/a.md")).toEqual([
      "alice@example.com",
      "bob@example.com",
      "svc@example.com",
    ]);
    // ...but bob's exclusion carves him out of the private subtree.
    expect(audienceOf("//depot/docs/private/x.md")).toEqual([
      "alice@example.com",
      "svc@example.com",
    ]);
    // carol has no upstream email — the admin member mapping materializes her.
    expect(audienceOf("//depot/eng/e.md")).toEqual([
      "alice@example.com",
      "carol@mapped.example",
      "svc@example.com",
    ]);

    // Cursor contract: every yield's cursor is its top-level key, ascending.
    const cursors = yields.map((y) => y.cursor);
    expect([...cursors].sort()).toEqual(cursors);
  });

  test("scope filters to the requested top-level containers", async () => {
    const connector = new PerforceConnector();
    const yields = await collect(
      connector.syncPermissionSnapshot(
        permissionParams({
          scope: { containerKeys: ["depot://depot/eng"] },
        }),
      ),
    );
    expect(
      yields.every((y) =>
        (y.kind === "container" ? y.containerKey : y.containerKey).startsWith(
          "depot://depot/eng",
        ),
      ),
    ).toBe(true);
  });

  test("cursor resume skips completed top-level containers", async () => {
    const connector = new PerforceConnector();
    const yields = await collect(
      connector.syncPermissionSnapshot(
        permissionParams({ cursor: "depot://depot/eng" }),
      ),
    );
    expect(
      yields.some((y) => y.containerKey.startsWith("depot://depot/docs")),
    ).toBe(false);
    expect(
      yields.some((y) => y.containerKey.startsWith("depot://depot/eng")),
    ).toBe(true);
  });

  test("missing admin configuration fails the pass loudly", async () => {
    const connector = new PerforceConnector();
    await expect(
      collect(
        connector.syncPermissionSnapshot(
          permissionParams({
            config: { ...CONFIG, p4Port: undefined, adminUsername: undefined },
          }),
        ),
      ),
    ).rejects.toThrow(/requires adminUsername/);
    // Without a tenant the shim scope is unknown; the pass must fail rather
    // than fall back to a shared pod carrying another tenant's credentials.
    await expect(
      collect(
        connector.syncPermissionSnapshot(
          permissionParams({ identity: undefined }),
        ),
      ),
    ).rejects.toThrow(/requires the connector's identity/);
    await expect(
      collect(
        connector.syncPermissionSnapshot(
          permissionParams({
            credentials: { email: "reader", apiToken: "t" },
          }),
        ),
      ),
    ).rejects.toThrow(/admin password/);
  });
});

describe("syncGroups", () => {
  test("rosters real groups (server-scoped ids) plus the all-users group", async () => {
    const connector = new PerforceConnector();
    const groups = await collect(connector.syncGroups(permissionParams()));

    const byId = new Map<string, GroupMembershipYield>(
      groups.map((g) => [g.groupId, g]),
    );
    // Server scope: lowercased, ssl: stripped — distinctive across servers.
    const devs = byId.get("p4group:p4.example.com:1666:devs");
    expect(devs).toBeDefined();
    expect(devs?.members.map((m) => m.accountId)).toEqual(["alice", "bob"]);
    expect(devs?.members[0]).toMatchObject({
      email: "alice@example.com",
      displayName: "Alice A",
    });

    const allUsers = byId.get("p4users:p4.example.com:1666");
    expect(allUsers?.members.map((m) => m.accountId)).toEqual([
      "alice",
      "bob",
      "carol",
      "svc-archestra",
    ]);
    // carol's upstream email is hidden → rostered with null (admin-visible).
    expect(
      allUsers?.members.find((m) => m.accountId === "carol")?.email,
    ).toBeNull();
  });
});

describe("probePermissionChanges", () => {
  test("first probe and any drift require a full pass; steady state does not", async () => {
    const connector = new PerforceConnector();
    const first = await connector.probePermissionChanges({
      config: CONFIG,
      credentials: CREDENTIALS,
      identity: IDENTITY,
      state: null,
    });
    expect(first.fullRequired).toBe(true);

    const steady = await connector.probePermissionChanges({
      config: CONFIG,
      credentials: CREDENTIALS,
      identity: IDENTITY,
      state: first.nextState,
    });
    expect(steady.fullRequired).toBe(false);
    expect(steady.dirtyContainerKeys).toEqual([]);

    fakeData.protects.push({
      perm: "read",
      user: "mallory",
      host: "*",
      depotFile: "//depot/...",
    });
    const drifted = await connector.probePermissionChanges({
      config: CONFIG,
      credentials: CREDENTIALS,
      identity: IDENTITY,
      state: first.nextState,
    });
    expect(drifted.fullRequired).toBe(true);
  });
});

describe("refreshContainerAudiences", () => {
  test("re-resolves stored signature containers and skips vanished ones", async () => {
    const connector = new PerforceConnector();
    const snapshot = await collect(
      connector.syncPermissionSnapshot(permissionParams()),
    );
    const storedKeys = snapshot
      .filter((y) => y.kind === "container")
      .map((y) => y.containerKey);

    const refreshed = await collect(
      connector.refreshContainerAudiences({
        config: CONFIG,
        credentials: CREDENTIALS,
        identity: IDENTITY,
        containerKeys: [
          ...storedKeys,
          "depot://depot/docs/acl:deadbeef00000000",
        ],
        readIngestedDocuments,
        resolveMappedEmail: (accountId) =>
          accountId === "carol" ? "carol@mapped.example" : null,
      }),
    );
    // Every live key re-yielded, the vanished signature silently skipped.
    expect(refreshed.map((r) => r.containerKey).sort()).toEqual(
      [...storedKeys].sort(),
    );
    const docsAcl = refreshed.find(
      (r) =>
        r.containerKey.startsWith("depot://depot/docs/acl:") &&
        r.permissions.users?.includes("bob@example.com"),
    );
    expect(docsAcl?.permissions.users).toEqual([
      "alice@example.com",
      "bob@example.com",
      "svc@example.com",
    ]);
  });
});

describe("scopeKeyForDocument", () => {
  test("maps the content-sync depotRoot stamp to the top-level container", () => {
    const connector = new PerforceConnector();
    expect(connector.scopeKeyForDocument({ depotRoot: "//depot/docs" })).toBe(
      "depot://depot/docs",
    );
    expect(connector.scopeKeyForDocument({})).toBeNull();
  });
});

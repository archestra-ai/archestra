import type { McpDeploymentStatusEntry } from "@archestra/shared";
import { describe, expect, it } from "vitest";
import {
  bucketOf,
  type CatalogItemForIssues,
  computeMcpServerIssues,
  formatIssueBreakdown,
  type InstalledServerForIssues,
  type IssueViewer,
  needsAttention,
  summarizeMcpServerIssues,
} from "./mcp-server-issues";

const ME = "user-me";
const OTHER = "user-other";

function item(
  overrides: Partial<CatalogItemForIssues> & { id: string },
): CatalogItemForIssues {
  return {
    serverType: "local",
    multitenant: false,
    catalogReinstallRequired: false,
    imageApprovalRequired: false,
    ...overrides,
  };
}

function server(
  overrides: Partial<InstalledServerForIssues> & {
    id: string;
    catalogId: string;
  },
): InstalledServerForIssues {
  // The generated API type declares the two enums non-nullable although the
  // API sends null when there is nothing to report; the cast mirrors reality.
  return {
    ownerId: ME,
    teamId: null,
    scope: "personal",
    localInstallationStatus: "success",
    localInstallationError: null,
    oauthRefreshError: null,
    oauthRefreshErrorMessage: null,
    oauthRefreshErrorDescription: null,
    oauthRefreshFailedAt: null,
    reinstallRequired: false,
    reinstallReason: null,
    ...overrides,
  } as InstalledServerForIssues;
}

function entry(
  overrides: Partial<McpDeploymentStatusEntry> & {
    state: McpDeploymentStatusEntry["state"];
  },
): McpDeploymentStatusEntry {
  return { message: "", error: null, ...overrides };
}

// A plain member: owns their connections, no admin rights.
const member: IssueViewer = {
  userId: ME,
  canReauthenticate: (s) => s.ownerId === ME,
  canManageInstalls: false,
  canEditCatalog: false,
};
const admin: IssueViewer = {
  userId: ME,
  // Admins may re-auth org/team connections but never someone's personal one.
  canReauthenticate: (s) => s.scope !== "personal" || s.ownerId === ME,
  canManageInstalls: true,
  canEditCatalog: true,
};

describe("computeMcpServerIssues", () => {
  it("reports nothing for healthy catalogs", () => {
    const issues = computeMcpServerIssues({
      items: [item({ id: "a" }), item({ id: "r", serverType: "remote" })],
      servers: [server({ id: "s1", catalogId: "a" })],
      deploymentStatuses: { s1: entry({ state: "running" }) },
      viewer: member,
    });
    expect(issues.size).toBe(0);
  });

  it("collapses failed installs of a multi-tenant catalog into one Failed to start", () => {
    const issues = computeMcpServerIssues({
      items: [item({ id: "a", multitenant: true })],
      servers: [
        server({
          id: "s1",
          catalogId: "a",
          localInstallationStatus: "error",
          localInstallationError: "image pull failed",
        }),
        server({
          id: "s2",
          catalogId: "a",
          ownerId: OTHER,
          localInstallationStatus: "error",
          localInstallationError: "image pull failed",
        }),
      ],
      deploymentStatuses: {},
      viewer: member,
    });
    expect(issues.get("a")).toEqual([
      {
        kind: "failed-to-start",
        severity: "down",
        audience: "you",
        catalogId: "a",
        serverId: "s1",
        detail: "image pull failed",
        since: null,
      },
    ]);
  });

  it("dedupes single-tenant failed installs by pod", () => {
    const issues = computeMcpServerIssues({
      items: [item({ id: "a" })],
      servers: [
        server({ id: "s1", catalogId: "a", localInstallationStatus: "error" }),
        server({ id: "s2", catalogId: "a", localInstallationStatus: "error" }),
        server({ id: "s3", catalogId: "a", localInstallationStatus: "error" }),
      ],
      deploymentStatuses: {
        s1: entry({ state: "failed", podName: "pod-1" }),
        s2: entry({ state: "failed", podName: "pod-1" }),
        s3: entry({ state: "failed", podName: "pod-2" }),
      },
      viewer: member,
    });
    expect(issues.get("a")?.map((i) => i.serverId)).toEqual(["s1", "s3"]);
  });

  it("maps runtime states: failed → Not running (once per deployment, with restarts), pending+error → Stuck starting, pending/waking → Starting", () => {
    const issues = computeMcpServerIssues({
      items: [item({ id: "a" }), item({ id: "b" }), item({ id: "c" })],
      servers: [
        server({ id: "s1", catalogId: "a" }),
        server({ id: "s2", catalogId: "a" }),
        server({ id: "s3", catalogId: "b" }),
        server({ id: "s4", catalogId: "c" }),
      ],
      deploymentStatuses: {
        s1: entry({
          state: "failed",
          deploymentName: "dep-a",
          error: "CrashLoopBackOff",
          restartCount: 4,
        }),
        s2: entry({ state: "failed", deploymentName: "dep-a", error: "x" }),
        s3: entry({
          state: "pending",
          error: "ImagePullBackOff: image not found",
        }),
        s4: entry({ state: "waking", message: "Waking (from idle)" }),
      },
      viewer: member,
    });
    expect(issues.get("a")).toEqual([
      expect.objectContaining({
        kind: "not-running",
        severity: "down",
        audience: "you",
        serverId: "s1",
        detail: "CrashLoopBackOff · 4 restarts",
      }),
    ]);
    expect(issues.get("b")?.[0]).toMatchObject({
      kind: "stuck-starting",
      severity: "attention",
      detail: "ImagePullBackOff: image not found",
    });
    expect(issues.get("c")?.[0]).toMatchObject({
      kind: "starting",
      severity: "progress",
      audience: "system",
    });
  });

  it("treats a pending install as Starting — unless its pod already failed — and never double-reports a failed install", () => {
    const issues = computeMcpServerIssues({
      items: [item({ id: "a" }), item({ id: "b" }), item({ id: "c" })],
      servers: [
        server({
          id: "s1",
          catalogId: "a",
          localInstallationStatus: "pending",
        }),
        server({ id: "s2", catalogId: "b", localInstallationStatus: "error" }),
        server({
          id: "s3",
          catalogId: "c",
          localInstallationStatus: "pending",
        }),
      ],
      deploymentStatuses: {
        s1: entry({ state: "pending" }),
        s2: entry({ state: "failed", error: "CrashLoopBackOff" }),
        s3: entry({
          state: "failed",
          error: "CrashLoopBackOff",
          restartCount: 41,
        }),
      },
      viewer: member,
    });
    expect(issues.get("a")?.map((i) => i.kind)).toEqual(["starting"]);
    expect(issues.get("b")?.map((i) => i.kind)).toEqual(["failed-to-start"]);
    expect(issues.get("c")?.[0]).toMatchObject({
      kind: "failed-to-start",
      detail: "CrashLoopBackOff · 41 restarts",
    });
  });

  it("drops the runtime's 'Deployment <name> failed:' prefix from causes", () => {
    const issues = computeMcpServerIssues({
      items: [item({ id: "a" })],
      servers: [
        server({
          id: "s1",
          catalogId: "a",
          localInstallationStatus: "error",
          localInstallationError:
            "Deployment mcp-x-abc failed: CrashLoopBackOff - back-off 20s restarting failed container=mcp-server pod=mcp-x-abc-1_default(uid)",
        }),
      ],
      deploymentStatuses: {},
      viewer: member,
    });
    expect(issues.get("a")?.[0].detail).toBe(
      "CrashLoopBackOff - back-off 20s restarting failed",
    );
  });

  it("ignores runtime state for remote catalogs", () => {
    const issues = computeMcpServerIssues({
      items: [item({ id: "r", serverType: "remote" })],
      servers: [server({ id: "s1", catalogId: "r" })],
      deploymentStatuses: { s1: entry({ state: "failed" }) },
      viewer: member,
    });
    expect(issues.size).toBe(0);
  });

  it("reports every connection needing re-authentication, owned by you or by others, with since", () => {
    const issues = computeMcpServerIssues({
      items: [item({ id: "r", serverType: "remote" })],
      servers: [
        server({
          id: "mine",
          catalogId: "r",
          oauthRefreshError: "refresh_failed",
          oauthRefreshErrorMessage: "invalid_grant",
          oauthRefreshFailedAt: "2026-08-18T10:00:00.000Z",
        }),
        server({
          id: "theirs",
          catalogId: "r",
          ownerId: OTHER,
          oauthRefreshError: "no_refresh_token",
        }),
      ],
      deploymentStatuses: {},
      viewer: member,
    });
    expect(issues.get("r")).toEqual([
      expect.objectContaining({
        kind: "needs-reauth",
        audience: "you",
        serverId: "mine",
        detail: "invalid_grant",
        since: "2026-08-18T10:00:00.000Z",
      }),
      expect.objectContaining({
        kind: "needs-reauth",
        audience: "others",
        serverId: "theirs",
      }),
    ]);
  });

  it("reports one catalog-scope reinstall for a multi-tenant catalog, actionable only for catalog editors", () => {
    const input = {
      items: [
        item({ id: "a", multitenant: true, catalogReinstallRequired: true }),
      ],
      servers: [
        server({ id: "s1", catalogId: "a", reinstallRequired: true }),
        server({ id: "s2", catalogId: "a", reinstallRequired: true }),
      ],
      deploymentStatuses: {},
    };
    expect(
      computeMcpServerIssues({ ...input, viewer: member }).get("a"),
    ).toEqual([
      expect.objectContaining({
        kind: "reinstall-required",
        audience: "others",
      }),
    ]);
    expect(
      computeMcpServerIssues({ ...input, viewer: member }).get("a")?.[0]
        .serverId,
    ).toBeUndefined();
    expect(
      computeMcpServerIssues({ ...input, viewer: admin }).get("a")?.[0]
        .audience,
    ).toBe("you");
  });

  it("explains per-install reinstall reasons and scopes them to owner or admin", () => {
    const servers = [
      server({
        id: "mine",
        catalogId: "a",
        reinstallRequired: true,
        reinstallReason: "new-input",
      }),
      server({
        id: "theirs",
        catalogId: "a",
        ownerId: OTHER,
        reinstallRequired: true,
        reinstallReason: "restart",
      }),
    ];
    const asMember = computeMcpServerIssues({
      items: [item({ id: "a" })],
      servers,
      deploymentStatuses: {},
      viewer: member,
    }).get("a");
    expect(asMember?.map((i) => [i.serverId, i.audience])).toEqual([
      ["mine", "you"],
      ["theirs", "others"],
    ]);
    expect(asMember?.[0].detail).toMatch(/new values/);
    const asAdmin = computeMcpServerIssues({
      items: [item({ id: "a" })],
      servers,
      deploymentStatuses: {},
      viewer: admin,
    }).get("a");
    expect(asAdmin?.every((i) => i.audience === "you")).toBe(true);
  });

  it("shows an image awaiting approval as yours to approvers and as in-progress to everyone else", () => {
    const input = {
      items: [item({ id: "a", imageApprovalRequired: true })],
      servers: [],
      deploymentStatuses: {},
    };
    expect(
      computeMcpServerIssues({ ...input, viewer: member }).get("a")?.[0],
    ).toMatchObject({ kind: "awaiting-approval", audience: "system" });
    expect(
      computeMcpServerIssues({ ...input, viewer: admin }).get("a")?.[0],
    ).toMatchObject({ kind: "awaiting-approval", audience: "you" });
  });
});

describe("summaries", () => {
  it("counts servers per bucket, actionable issues per kind, and the worst severity", () => {
    const issues = computeMcpServerIssues({
      items: [
        item({ id: "a" }),
        item({ id: "r", serverType: "remote" }),
        item({ id: "p" }),
        item({ id: "ok" }),
      ],
      servers: [
        server({ id: "s1", catalogId: "a", localInstallationStatus: "error" }),
        server({
          id: "s2",
          catalogId: "r",
          oauthRefreshError: "refresh_failed",
        }),
        server({
          id: "s3",
          catalogId: "r",
          ownerId: OTHER,
          oauthRefreshError: "refresh_failed",
        }),
        server({
          id: "s4",
          catalogId: "p",
          localInstallationStatus: "pending",
        }),
      ],
      deploymentStatuses: {},
      viewer: member,
    });
    const summary = summarizeMcpServerIssues(issues);
    expect(summary).toEqual({
      actionableServerCount: 2,
      actionableByKind: [
        { kind: "failed-to-start", count: 1 },
        { kind: "needs-reauth", count: 1 },
      ],
      othersServerCount: 0,
      inProgressServerCount: 1,
      severity: "down",
    });
    expect(formatIssueBreakdown(summary)).toBe(
      "1 failed to start · 1 needs re-authentication",
    );
    expect(bucketOf(issues.get("r") ?? [])).toBe("you");
    expect(bucketOf(issues.get("p") ?? [])).toBe("system");
    expect(needsAttention(issues.get("p"))).toBe(false);
    expect(needsAttention(issues.get("a"))).toBe(true);
    expect(needsAttention(issues.get("ok"))).toBe(false);
  });

  it("puts a server whose only issues are other people's into the others bucket, uncounted", () => {
    const issues = computeMcpServerIssues({
      items: [item({ id: "r", serverType: "remote" })],
      servers: [
        server({
          id: "theirs",
          catalogId: "r",
          ownerId: OTHER,
          oauthRefreshError: "refresh_failed",
        }),
      ],
      deploymentStatuses: {},
      viewer: member,
    });
    expect(summarizeMcpServerIssues(issues)).toEqual({
      actionableServerCount: 0,
      actionableByKind: [],
      othersServerCount: 1,
      inProgressServerCount: 0,
      severity: null,
    });
  });

  it("is attention-only when nothing is down, and empty when clean", () => {
    const warn = summarizeMcpServerIssues(
      computeMcpServerIssues({
        items: [item({ id: "a", imageApprovalRequired: true })],
        servers: [],
        deploymentStatuses: {},
        viewer: admin,
      }),
    );
    expect(warn.severity).toBe("attention");
    expect(summarizeMcpServerIssues(new Map()).severity).toBeNull();
  });
});

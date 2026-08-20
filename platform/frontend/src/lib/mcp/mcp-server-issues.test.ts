import {
  ARCHESTRA_MCP_CATALOG_ID,
  type McpDeploymentStatusEntry,
} from "@archestra/shared";
import { describe, expect, it } from "vitest";
import {
  attentionCatalogIds,
  bucketOf,
  type CatalogItemForIssues,
  canFixInstall,
  computeMcpServerIssues,
  facetIssues,
  type InstalledServerForIssues,
  type IssueViewer,
  needsAttention,
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
    alertMutes: [],
    ...overrides,
  } as InstalledServerForIssues;
}

function reauthMute(): InstalledServerForIssues["alertMutes"][number] {
  return {
    mcpServerId: "unused",
    issueKind: "needs-reauth",
    reason: "Owner is on leave",
    mutedAt: "2026-08-19T09:00:00.000Z",
  };
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
        muted: false,
        mutedReason: null,
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

describe("facets", () => {
  /**
   * The fleet every count on the registry is taken over: one server the viewer
   * must fix, one waiting on somebody else, one merely starting, one image
   * awaiting an approval the viewer cannot give, one item broken in two
   * different people's directions at once, and the built-in Archestra entry
   * that no surface may ever list.
   */
  const mixedFleet = () =>
    computeMcpServerIssues({
      items: [
        item({ id: "mine" }),
        item({ id: "theirs", serverType: "remote" }),
        item({ id: "starting" }),
        item({ id: "approval", imageApprovalRequired: true }),
        item({ id: "both", serverType: "remote" }),
        item({ id: "healthy" }),
        item({ id: ARCHESTRA_MCP_CATALOG_ID }),
      ],
      servers: [
        server({
          id: "s-mine",
          catalogId: "mine",
          localInstallationStatus: "error",
        }),
        server({
          id: "s-theirs",
          catalogId: "theirs",
          ownerId: OTHER,
          oauthRefreshError: "refresh_failed",
        }),
        server({
          id: "s-starting",
          catalogId: "starting",
          localInstallationStatus: "pending",
        }),
        // One connection of "both" is the viewer's to re-authenticate and one
        // is a colleague's: the item belongs to "you" and to nothing else.
        server({
          id: "s-both-mine",
          catalogId: "both",
          oauthRefreshError: "refresh_failed",
        }),
        server({
          id: "s-both-theirs",
          catalogId: "both",
          ownerId: OTHER,
          oauthRefreshError: "refresh_failed",
        }),
        server({ id: "s-healthy", catalogId: "healthy" }),
        server({
          id: "s-archestra",
          catalogId: ARCHESTRA_MCP_CATALOG_ID,
          localInstallationStatus: "error",
        }),
      ],
      deploymentStatuses: { "s-starting": entry({ state: "pending" }) },
      viewer: member,
    });

  it("lists the items the viewer has to act on, and only those", () => {
    expect(attentionCatalogIds(mixedFleet(), { audience: "you" })).toEqual([
      "mine",
      "both",
    ]);
  });

  /**
   * Why every surface has to be handed the live deployment feed. Runtime
   * faults exist only for a caller holding the statuses, so two callers over
   * one fleet disagree the moment one of them leaves them out — which is
   * exactly how the sidebar badge came to read "0" beside a list reading "1".
   */
  it("sees a crash-looping pod only when it is given the deployment statuses", () => {
    const fleet = (
      deploymentStatuses: Record<string, McpDeploymentStatusEntry>,
    ) =>
      computeMcpServerIssues({
        items: [item({ id: "crashy" })],
        servers: [server({ id: "s-crashy", catalogId: "crashy" })],
        deploymentStatuses,
        viewer: member,
      });

    const withFeed = attentionCatalogIds(
      fleet({ "s-crashy": entry({ state: "failed" }) }),
      { audience: "you" },
    );
    const withoutFeed = attentionCatalogIds(fleet({}), { audience: "you" });

    expect(withFeed).toEqual(["crashy"]);
    expect(withoutFeed).toEqual([]);
  });

  it("never lists the built-in Archestra entry, however broken it looks", () => {
    const issues = mixedFleet();
    expect(issues.has(ARCHESTRA_MCP_CATALOG_ID)).toBe(true);
    expect([
      ...attentionCatalogIds(issues, { audience: "you" }),
      ...attentionCatalogIds(issues, { audience: "others" }),
      ...attentionCatalogIds(issues, { audience: "muted" }),
    ]).not.toContain(ARCHESTRA_MCP_CATALOG_ID);
  });

  it("puts an item with faults in two buckets in yours only, once", () => {
    const issues = mixedFleet();
    expect(attentionCatalogIds(issues, { audience: "you" })).toEqual([
      "mine",
      "both",
    ]);
    expect(attentionCatalogIds(issues, { audience: "others" })).not.toContain(
      "both",
    );
    expect(bucketOf(issues.get("both") ?? [])).toBe("you");
  });

  it("leaves nothing broken out of every facet, and nothing merely starting in one", () => {
    const issues = mixedFleet();
    const others = attentionCatalogIds(issues, { audience: "others" });

    // "approval" is audience "system" to a non-approver but still blocks every
    // install, so it waits on somebody else rather than vanishing.
    expect(others).toEqual(["theirs", "approval"]);
    expect(others).not.toContain("starting");
    expect(attentionCatalogIds(issues, { audience: "you" })).not.toContain(
      "starting",
    );
    expect(needsAttention(issues.get("starting"))).toBe(false);
  });

  it("takes a muted alert out of both counts and lists it under Muted", () => {
    const issues = computeMcpServerIssues({
      items: [item({ id: "r", serverType: "remote" })],
      servers: [
        server({
          id: "s1",
          catalogId: "r",
          oauthRefreshError: "refresh_failed",
          alertMutes: [reauthMute()],
        }),
      ],
      deploymentStatuses: {},
      viewer: member,
    });

    expect(attentionCatalogIds(issues, { audience: "you" })).toEqual([]);
    expect(attentionCatalogIds(issues, { audience: "others" })).toEqual([]);
    expect(attentionCatalogIds(issues, { audience: "muted" })).toEqual(["r"]);
    // Still visible, still explained, and it carries the note the viewer gave
    // for it: muting hides the count, not the state or the reason for it.
    expect(facetIssues(issues.get("r") ?? [], "muted")).toEqual([
      expect.objectContaining({
        kind: "needs-reauth",
        muted: true,
        mutedReason: "Owner is on leave",
      }),
    ]);
  });

  it("keeps an item counted when only one of its two alerts is muted", () => {
    const issues = computeMcpServerIssues({
      items: [item({ id: "a" })],
      servers: [
        server({
          id: "s1",
          catalogId: "a",
          oauthRefreshError: "refresh_failed",
          alertMutes: [reauthMute()],
          reinstallRequired: true,
        }),
      ],
      deploymentStatuses: {},
      viewer: member,
    });

    expect(attentionCatalogIds(issues, { audience: "you" })).toEqual(["a"]);
    expect(attentionCatalogIds(issues, { audience: "muted" })).toEqual(["a"]);
    expect(
      facetIssues(issues.get("a") ?? [], "you").map((i) => i.kind),
    ).toEqual(["reinstall-required"]);
  });
});

describe("canFixInstall", () => {
  it("lets an installs admin repair a connection they do not own", () => {
    const theirs = server({ id: "s1", catalogId: "a", ownerId: OTHER });
    expect(canFixInstall({ server: theirs, viewer: member })).toBe(false);
    expect(canFixInstall({ server: theirs, viewer: admin })).toBe(true);
    expect(
      canFixInstall({
        server: server({ id: "s2", catalogId: "a" }),
        viewer: member,
      }),
    ).toBe(true);
  });
});

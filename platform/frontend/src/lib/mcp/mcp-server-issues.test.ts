import {
  ARCHESTRA_MCP_CATALOG_ID,
  type McpDeploymentStatusEntry,
} from "@archestra/shared";
import { describe, expect, it } from "vitest";
import {
  attentionCatalogIds,
  attentionSortRank,
  bucketOf,
  type CatalogItemForIssues,
  canFixInstall,
  computeMcpServerIssues,
  facetIssues,
  type InstalledServerForIssues,
  type IssueViewer,
} from "./mcp-server-issues";

const ME = "user-me";
const OTHER = "user-other";

function item(
  overrides: Partial<CatalogItemForIssues> & { id: string },
): CatalogItemForIssues {
  return {
    serverType: "local",
    multitenant: false,
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
    localInstallationStatus: "success",
    localInstallationError: null,
    oauthRefreshError: null,
    oauthRefreshErrorMessage: null,
    oauthRefreshErrorDescription: null,
    oauthRefreshFailedAt: null,
    updatedAt: "2026-08-01T00:00:00.000Z",
    alertMutes: [],
    ...overrides,
  } as InstalledServerForIssues;
}

function reauthMute({
  catalogId,
  serverId,
}: {
  catalogId: string;
  serverId: string;
}): InstalledServerForIssues["alertMutes"][number] {
  return {
    catalogId,
    mcpServerId: serverId,
    issueKind: "needs-reauth",
    issueFingerprint: "v1:needs-reauth:current",
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
};
const admin: IssueViewer = {
  userId: ME,
  canReauthenticate: () => true,
  canManageInstalls: true,
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

  it("reports nothing while an install is merely pending or a pod is starting", () => {
    const issues = computeMcpServerIssues({
      items: [item({ id: "a" }), item({ id: "b" }), item({ id: "c" })],
      servers: [
        server({
          id: "s1",
          catalogId: "a",
          localInstallationStatus: "pending",
        }),
        server({ id: "s2", catalogId: "b" }),
        server({
          id: "s3",
          catalogId: "c",
          localInstallationStatus: "discovering-tools",
        }),
      ],
      deploymentStatuses: {
        s1: entry({ state: "pending" }),
        s2: entry({ state: "waking", message: "Waking (from idle)" }),
        s3: entry({ state: "not_created" }),
      },
      viewer: member,
    });
    expect(issues.size).toBe(0);
  });

  it("clears a recorded install failure when the pod is provably healthy", () => {
    // A sync error can be recorded against a row whose old pod still serves
    // every call: the running pod is proof the installation works, so there
    // is nothing to act on.
    const issues = computeMcpServerIssues({
      items: [item({ id: "a" }), item({ id: "b" })],
      servers: [
        server({
          id: "s1",
          catalogId: "a",
          localInstallationStatus: "error",
          localInstallationError: "failed to sync tools",
        }),
        server({
          id: "s2",
          catalogId: "b",
          localInstallationStatus: "error",
          localInstallationError: "failed to sync tools",
        }),
      ],
      deploymentStatuses: {
        s1: entry({ state: "running" }),
        s2: entry({ state: "hibernated" }),
      },
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
        audience: "you",
        catalogId: "a",
        serverId: undefined,
        detail: "image pull failed",
        since: null,
        fingerprint: expect.stringMatching(/^v1:failed-to-start:/),
        muted: false,
        mutedReason: null,
      },
    ]);
  });

  it("fingerprints shared install failures independently of sibling order", () => {
    const catalog = item({ id: "shared", multitenant: true });
    const first = server({
      id: "s1",
      catalogId: "shared",
      localInstallationStatus: "error",
      localInstallationError: "image pull failed",
    });
    const second = server({
      id: "s2",
      catalogId: "shared",
      localInstallationStatus: "error",
      localInstallationError: "container exited",
    });
    const fingerprint = (servers: InstalledServerForIssues[]) =>
      computeMcpServerIssues({
        items: [catalog],
        servers,
        deploymentStatuses: {},
        viewer: member,
      }).get("shared")?.[0]?.fingerprint;

    expect(fingerprint([first, second])).toBe(fingerprint([second, first]));
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

  it("maps runtime states: failed → Not running (once per deployment, with restarts), pending+error → Failed to start, a missing pod after a successful install → Not running", () => {
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
        s4: entry({ state: "not_created", message: "Pod was deleted" }),
      },
      viewer: member,
    });
    expect(issues.get("a")).toEqual([
      expect.objectContaining({
        kind: "not-running",
        audience: "you",
        serverId: "s1",
        detail: "CrashLoopBackOff · 4 restarts",
      }),
    ]);
    expect(issues.get("b")?.[0]).toMatchObject({
      kind: "failed-to-start",
      detail: "ImagePullBackOff: image not found",
    });
    expect(issues.get("c")?.[0]).toMatchObject({
      kind: "not-running",
      detail: "Pod was deleted",
    });
  });

  it("reports a failed install once even when its pod also failed, and prefers the install error as the cause", () => {
    const issues = computeMcpServerIssues({
      items: [item({ id: "a" }), item({ id: "b" })],
      servers: [
        server({
          id: "s1",
          catalogId: "a",
          localInstallationStatus: "error",
          localInstallationError: "missing env var MCP_API_KEY",
        }),
        server({
          id: "s2",
          catalogId: "b",
          localInstallationStatus: "pending",
        }),
      ],
      deploymentStatuses: {
        s1: entry({ state: "failed", error: "CrashLoopBackOff" }),
        s2: entry({
          state: "failed",
          error: "CrashLoopBackOff",
          restartCount: 41,
        }),
      },
      viewer: member,
    });
    expect(issues.get("a")?.map((i) => i.kind)).toEqual(["failed-to-start"]);
    expect(issues.get("a")?.[0].detail).toBe("missing env var MCP_API_KEY");
    expect(issues.get("b")?.[0]).toMatchObject({
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
    const servers = [
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
    ];
    const issues = computeMcpServerIssues({
      items: [item({ id: "r", serverType: "remote" })],
      servers,
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
    expect(
      computeMcpServerIssues({
        items: [item({ id: "r", serverType: "remote" })],
        servers,
        deploymentStatuses: {},
        viewer: admin,
      })
        .get("r")
        ?.every((issue) => issue.audience === "you"),
    ).toBe(true);
  });
});

describe("facets", () => {
  /**
   * The fleet every count on the registry is taken over: one server the viewer
   * must fix, one owned by another actor, one item broken in two different
   * people's directions at once, and the built-in Archestra entry that no
   * surface may ever list.
   */
  const mixedFleet = () =>
    computeMcpServerIssues({
      items: [
        item({ id: "mine" }),
        item({ id: "theirs", serverType: "remote" }),
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
      deploymentStatuses: {},
      viewer: member,
    });

  it("lists the items the viewer has to act on, and only those", () => {
    expect(attentionCatalogIds(mixedFleet(), { audience: "you" })).toEqual([
      "mine",
      "both",
    ]);
    expect(attentionCatalogIds(mixedFleet(), { audience: "others" })).toEqual([
      "theirs",
    ]);
  });

  it("ranks actionable items ahead of other issues and healthy rows", () => {
    const issues = mixedFleet();

    expect(attentionSortRank(issues.get("mine"))).toBe(0);
    expect(attentionSortRank(issues.get("theirs"))).toBe(1);
    expect(attentionSortRank(issues.get("healthy"))).toBe(2);
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

  it("takes a dismissed alert out of both counts and lists it under Dismissed", () => {
    const issues = computeMcpServerIssues({
      items: [item({ id: "r", serverType: "remote" })],
      servers: [
        server({
          id: "s1",
          catalogId: "r",
          oauthRefreshError: "refresh_failed",
          alertMutes: [reauthMute({ catalogId: "r", serverId: "s1" })],
        }),
      ],
      deploymentStatuses: {},
      viewer: member,
    });

    expect(attentionCatalogIds(issues, { audience: "you" })).toEqual([]);
    expect(attentionCatalogIds(issues, { audience: "others" })).toEqual([]);
    expect(attentionCatalogIds(issues, { audience: "muted" })).toEqual(["r"]);
    expect(attentionSortRank(issues.get("r"))).toBe(2);
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
          alertMutes: [reauthMute({ catalogId: "a", serverId: "s1" })],
          localInstallationStatus: "error",
          localInstallationError: "image pull failed",
        }),
      ],
      deploymentStatuses: {},
      viewer: member,
    });

    expect(attentionCatalogIds(issues, { audience: "you" })).toEqual(["a"]);
    expect(attentionCatalogIds(issues, { audience: "muted" })).toEqual(["a"]);
    expect(
      facetIssues(issues.get("a") ?? [], "you").map((i) => i.kind),
    ).toEqual(["failed-to-start"]);
  });

  it("applies a catalog-level dismissal only to the matching failure episode", () => {
    const baseItem = item({ id: "shared", multitenant: true });
    const failingServers = (error: string, alertMutes = [] as never[]) => [
      server({
        id: "s1",
        catalogId: "shared",
        localInstallationStatus: "error",
        localInstallationError: error,
        alertMutes,
      }),
    ];
    const firstPass = computeMcpServerIssues({
      items: [baseItem],
      servers: failingServers("image pull failed"),
      deploymentStatuses: {},
      viewer: admin,
    });
    const fingerprint = firstPass.get("shared")?.[0]?.fingerprint;
    expect(fingerprint).toBeTruthy();

    const dismissal = {
      catalogId: "shared",
      mcpServerId: null,
      issueKind: "failed-to-start" as const,
      issueFingerprint: fingerprint as string,
      reason: "Maintenance window next week",
      mutedAt: "2026-08-02T00:00:00.000Z",
    };
    const dismissed = computeMcpServerIssues({
      items: [{ ...baseItem, alertMutes: [dismissal] }],
      servers: failingServers("image pull failed"),
      deploymentStatuses: {},
      viewer: admin,
    });
    expect(dismissed.get("shared")?.[0]).toMatchObject({
      muted: true,
      mutedReason: "Maintenance window next week",
    });

    // A different failure is a different episode: the old dismissal must not
    // silence it.
    const laterEpisode = computeMcpServerIssues({
      items: [{ ...baseItem, alertMutes: [dismissal] }],
      servers: failingServers("container exited with code 1"),
      deploymentStatuses: {},
      viewer: admin,
    });
    expect(laterEpisode.get("shared")?.[0]?.muted).toBe(false);
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

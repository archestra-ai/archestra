import { type MockInstance, vi } from "vitest";
import config from "@/config";
import { McpServerModel, OrganizationModel } from "@/models";
import { MCP_SERVER_LAST_USED_REFRESH_INTERVAL_MS } from "@/models/mcp-server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { drainBackgroundWork } from "@/utils/background-work";
import { mcpActiveUseTracker } from "./mcp-active-use.ee";

/**
 * The tracker is a process-wide singleton, so every test works on its own
 * server id and cleans up after itself — no state bleeds between tests.
 */
let serverIdCounter = 0;
const usedServerIds: string[] = [];
function nextServerId(): string {
  const id = `mcp-server-${++serverIdCounter}`;
  usedServerIds.push(id);
  return id;
}

/** A promise the test resolves by hand, to hold an operation "in flight". */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("mcpActiveUseTracker", () => {
  // The only true boundary here is the throttled persistence write; everything
  // else is the in-memory state the sweeper actually reads.
  let updateLastUsed: MockInstance<typeof McpServerModel.updateLastUsed>;
  let organizationId: string;

  beforeEach(async ({ makeOrganization }) => {
    vi.restoreAllMocks();
    // Only the sweeper reads what this tracker records, so it deliberately
    // does nothing while idle hibernation is off. Every test below is about
    // what it records when the feature is on — which now means the beta flag
    // is set and the organization has opted in, not just that an env var is
    // set.
    config.orchestrator.mcpIdleHibernation.betaEnabled = true;
    organizationId = (
      await makeOrganization({ mcpIdleHibernationEnabled: true })
    ).id;
    // stamp() is synchronous, so it reads a process-local mirror of the
    // toggle. Prime it exactly the way the running system does.
    await OrganizationModel.getMcpIdleHibernationEnabled();
    updateLastUsed = vi
      .spyOn(McpServerModel, "updateLastUsed")
      .mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await drainBackgroundWork();
    config.orchestrator.mcpIdleHibernation.hardDisabled = false;
    config.orchestrator.mcpIdleHibernation.betaEnabled = false;
    for (const id of usedServerIds) mcpActiveUseTracker.remove(id);
    usedServerIds.length = 0;
  });

  describe("trackActiveUse", () => {
    test("counts the server as active for the duration of the operation", async () => {
      const id = nextServerId();
      expect(mcpActiveUseTracker.getActiveUseCount(id)).toBe(0);

      const result = await mcpActiveUseTracker.trackActiveUse(id, async () => {
        // The sweeper reads this mid-flight: a server with work in progress is
        // never idle, however stale its last-used timestamp looks.
        expect(mcpActiveUseTracker.getActiveUseCount(id)).toBe(1);
        return "tool-result";
      });

      expect(result).toBe("tool-result");
      expect(mcpActiveUseTracker.getActiveUseCount(id)).toBe(0);
    });

    test("releases the active count when the operation throws", async () => {
      const id = nextServerId();

      await expect(
        mcpActiveUseTracker.trackActiveUse(id, async () => {
          expect(mcpActiveUseTracker.getActiveUseCount(id)).toBe(1);
          throw new Error("tool call failed");
        }),
      ).rejects.toThrow("tool call failed");

      // Without the finally path a single failed call would pin the server
      // "active" forever and the sweeper could never hibernate it again.
      expect(mcpActiveUseTracker.getActiveUseCount(id)).toBe(0);
    });

    test("counts concurrent calls for the same server and only reaches zero when the last one finishes", async () => {
      const id = nextServerId();
      const first = deferred();
      const second = deferred();

      const firstCall = mcpActiveUseTracker.trackActiveUse(
        id,
        () => first.promise,
      );
      const secondCall = mcpActiveUseTracker.trackActiveUse(
        id,
        () => second.promise,
      );
      expect(mcpActiveUseTracker.getActiveUseCount(id)).toBe(2);

      first.resolve();
      await firstCall;
      // Still busy — the second call is what keeps the server awake.
      expect(mcpActiveUseTracker.getActiveUseCount(id)).toBe(1);

      second.resolve();
      await secondCall;
      expect(mcpActiveUseTracker.getActiveUseCount(id)).toBe(0);
    });

    test("counts nested calls for the same server independently", async () => {
      const id = nextServerId();

      await mcpActiveUseTracker.trackActiveUse(id, async () => {
        expect(mcpActiveUseTracker.getActiveUseCount(id)).toBe(1);
        await mcpActiveUseTracker.trackActiveUse(id, async () => {
          expect(mcpActiveUseTracker.getActiveUseCount(id)).toBe(2);
        });
        // The inner call finishing must not clear the outer call's claim.
        expect(mcpActiveUseTracker.getActiveUseCount(id)).toBe(1);
      });

      expect(mcpActiveUseTracker.getActiveUseCount(id)).toBe(0);
    });

    test("tracks each server separately", async () => {
      const busy = nextServerId();
      const idle = nextServerId();
      const held = deferred();

      const call = mcpActiveUseTracker.trackActiveUse(busy, () => held.promise);
      expect(mcpActiveUseTracker.getActiveUseCount(busy)).toBe(1);
      expect(mcpActiveUseTracker.getActiveUseCount(idle)).toBe(0);

      held.resolve();
      await call;
    });
  });

  describe("in-memory last-used watermark", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    test("stamp() moves the watermark forward", () => {
      const id = nextServerId();
      vi.useFakeTimers();

      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      mcpActiveUseTracker.stamp(id);
      expect(mcpActiveUseTracker.getInMemoryLastUsedAt([id])).toEqual(
        new Date("2026-01-01T00:00:00.000Z"),
      );

      vi.setSystemTime(new Date("2026-01-01T00:05:00.000Z"));
      mcpActiveUseTracker.stamp(id);
      expect(mcpActiveUseTracker.getInMemoryLastUsedAt([id])).toEqual(
        new Date("2026-01-01T00:05:00.000Z"),
      );
    });

    test("trackActiveUse moves the watermark on completion, not just at start", async () => {
      const id = nextServerId();
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

      await mcpActiveUseTracker.trackActiveUse(id, async () => {
        expect(mcpActiveUseTracker.getInMemoryLastUsedAt([id])).toEqual(
          new Date("2026-01-01T00:00:00.000Z"),
        );
        // A long-running call must be credited when it ENDS, otherwise the
        // sweeper measures idleness from before the work happened.
        vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
      });

      expect(mcpActiveUseTracker.getInMemoryLastUsedAt([id])).toEqual(
        new Date("2026-01-01T00:10:00.000Z"),
      );
    });

    test("getInMemoryLastUsedAt returns the latest timestamp across several servers", () => {
      const oldest = nextServerId();
      const newest = nextServerId();
      const middle = nextServerId();
      vi.useFakeTimers();

      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      mcpActiveUseTracker.stamp(oldest);
      vi.setSystemTime(new Date("2026-01-01T00:02:00.000Z"));
      mcpActiveUseTracker.stamp(middle);
      vi.setSystemTime(new Date("2026-01-01T00:07:00.000Z"));
      mcpActiveUseTracker.stamp(newest);

      // Order of the ids must not matter — a shared deployment is only idle
      // when its newest caller is idle.
      expect(
        mcpActiveUseTracker.getInMemoryLastUsedAt([oldest, newest, middle]),
      ).toEqual(new Date("2026-01-01T00:07:00.000Z"));
      expect(
        mcpActiveUseTracker.getInMemoryLastUsedAt([newest, middle, oldest]),
      ).toEqual(new Date("2026-01-01T00:07:00.000Z"));
    });

    test("getInMemoryLastUsedAt returns null for unknown servers", () => {
      expect(mcpActiveUseTracker.getInMemoryLastUsedAt([])).toBeNull();
      expect(
        mcpActiveUseTracker.getInMemoryLastUsedAt(["never-seen"]),
      ).toBeNull();
    });

    test("getInMemoryLastUsedAt ignores unknown ids mixed in with known ones", () => {
      const known = nextServerId();
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      mcpActiveUseTracker.stamp(known);

      expect(
        mcpActiveUseTracker.getInMemoryLastUsedAt(["never-seen", known]),
      ).toEqual(new Date("2026-01-01T00:00:00.000Z"));
    });
  });

  describe("remove", () => {
    test("drops both the active counter and the watermark", async () => {
      const id = nextServerId();
      const held = deferred();

      const call = mcpActiveUseTracker.trackActiveUse(id, () => held.promise);
      expect(mcpActiveUseTracker.getActiveUseCount(id)).toBe(1);
      expect(mcpActiveUseTracker.getInMemoryLastUsedAt([id])).not.toBeNull();

      mcpActiveUseTracker.remove(id);

      // An uninstalled server leaves nothing behind that would keep the
      // sweeper (or a later install reusing the id) seeing phantom demand.
      expect(mcpActiveUseTracker.getActiveUseCount(id)).toBe(0);
      expect(mcpActiveUseTracker.getInMemoryLastUsedAt([id])).toBeNull();

      held.resolve();
      await call;
    });

    test("is a no-op for a server that was never tracked", () => {
      expect(() => mcpActiveUseTracker.remove("never-seen")).not.toThrow();
      expect(mcpActiveUseTracker.getActiveUseCount("never-seen")).toBe(0);
    });
  });

  describe("persistence is best-effort", () => {
    test("a failed last-used write still moves the in-memory watermark", async () => {
      const id = nextServerId();
      updateLastUsed.mockRejectedValue(new Error("database unavailable"));

      mcpActiveUseTracker.stamp(id);
      await drainBackgroundWork();

      // This is the fail-safe the sweeper depends on: a dropped persistence
      // write must never make a busy server look idle.
      expect(mcpActiveUseTracker.getInMemoryLastUsedAt([id])).not.toBeNull();
      expect(updateLastUsed).toHaveBeenCalledWith(id);
    });

    test("a failed last-used write does not break trackActiveUse", async () => {
      const id = nextServerId();
      updateLastUsed.mockRejectedValue(new Error("database unavailable"));

      const result = await mcpActiveUseTracker.trackActiveUse(id, async () => {
        expect(mcpActiveUseTracker.getActiveUseCount(id)).toBe(1);
        return "tool-result";
      });
      await drainBackgroundWork();

      expect(result).toBe("tool-result");
      expect(mcpActiveUseTracker.getActiveUseCount(id)).toBe(0);
      expect(mcpActiveUseTracker.getInMemoryLastUsedAt([id])).not.toBeNull();
    });

    test("persists the last-used timestamp on the demand path", async () => {
      const id = nextServerId();

      await mcpActiveUseTracker.trackActiveUse(id, async () => undefined);
      await drainBackgroundWork();

      expect(updateLastUsed).toHaveBeenCalledWith(id);
    });

    test("one tool call costs one write, not one per stamp", async () => {
      const id = nextServerId();

      // trackActiveUse stamps at start AND completion. The second stamp lands
      // inside the refresh interval, where updateLastUsed can only no-op, so
      // it must not reach the database at all.
      await mcpActiveUseTracker.trackActiveUse(id, async () => undefined);
      await mcpActiveUseTracker.trackActiveUse(id, async () => undefined);
      await drainBackgroundWork();

      expect(updateLastUsed).toHaveBeenCalledTimes(1);
    });

    test("writes again once the refresh interval has passed", async () => {
      const id = nextServerId();
      mcpActiveUseTracker.stamp(id);

      vi.spyOn(Date, "now").mockReturnValue(
        Date.now() + MCP_SERVER_LAST_USED_REFRESH_INTERVAL_MS + 1,
      );
      mcpActiveUseTracker.stamp(id);
      await drainBackgroundWork();

      expect(updateLastUsed).toHaveBeenCalledTimes(2);
    });
  });

  describe("while idle hibernation is off", () => {
    test("records nothing and never touches the database", async () => {
      const id = nextServerId();
      // The organization turned the feature off: the toggle is the switch the
      // tracker follows, not the env var.
      await OrganizationModel.patch(organizationId, {
        mcpIdleHibernationEnabled: false,
      });
      await OrganizationModel.getMcpIdleHibernationEnabled();

      await mcpActiveUseTracker.trackActiveUse(id, async () => undefined);
      mcpActiveUseTracker.stamp(id);
      await drainBackgroundWork();

      // Nothing reads the watermark when no sweeper runs, and the demand paths
      // that stamp sit on the hot tool-call route.
      expect(updateLastUsed).not.toHaveBeenCalled();
      expect(mcpActiveUseTracker.getInMemoryLastUsedAt([id])).toBeNull();
    });

    test("records nothing while the beta flag is off, whatever the organization chose", async () => {
      const id = nextServerId();
      config.orchestrator.mcpIdleHibernation.betaEnabled = false;

      await mcpActiveUseTracker.trackActiveUse(id, async () => undefined);
      mcpActiveUseTracker.stamp(id);
      await drainBackgroundWork();

      expect(updateLastUsed).not.toHaveBeenCalled();
      expect(mcpActiveUseTracker.getInMemoryLastUsedAt([id])).toBeNull();
    });

    test("still counts in-flight operations", async () => {
      const id = nextServerId();
      // The operator's kill switch, the other way the feature can be off.
      config.orchestrator.mcpIdleHibernation.hardDisabled = true;
      const inFlight = deferred();

      const operation = mcpActiveUseTracker.trackActiveUse(id, async () => {
        expect(mcpActiveUseTracker.getActiveUseCount(id)).toBe(1);
        await inFlight.promise;
      });
      inFlight.resolve();
      await operation;

      expect(mcpActiveUseTracker.getActiveUseCount(id)).toBe(0);
    });
  });
});

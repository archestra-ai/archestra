// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { type MockInstance, vi } from "vitest";
import config from "@/config";
import { enterpriseTier } from "@/enterprise-tier";
import { McpServerModel, OrganizationModel } from "@/models";
import {
  MCP_DEMAND_HEARTBEAT_INTERVAL_MS,
  MCP_SERVER_LAST_USED_REFRESH_INTERVAL_MS,
} from "@/models/mcp-server";
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
    // Demand records whenever the operator offers idle hibernation. The org
    // toggle is intentionally not a demand-side gate: its process-local mirror
    // may lag another replica that has already started sweeping.
    config.orchestrator.mcpIdleHibernation.betaEnabled = true;
    organizationId = (
      await makeOrganization({ mcpIdleHibernationEnabled: true })
    ).id;
    await OrganizationModel.getMcpIdleHibernationEnabled();
    updateLastUsed = vi
      .spyOn(McpServerModel, "updateLastUsed")
      .mockResolvedValue(undefined);
  });

  afterEach(async () => {
    mcpActiveUseTracker.stop();
    await drainBackgroundWork();
    vi.useRealTimers();
    config.orchestrator.mcpIdleHibernation.hardDisabled = false;
    config.orchestrator.mcpIdleHibernation.betaEnabled = false;
    for (const id of usedServerIds) mcpActiveUseTracker.remove(id);
    usedServerIds.length = 0;
  });

  describe("trackActiveUse", () => {
    test("requires cross-replica tracking when the beta is off locally", async () => {
      const id = nextServerId();
      config.orchestrator.mcpIdleHibernation.betaEnabled = false;
      updateLastUsed.mockRejectedValue(new Error("database unavailable"));
      const operation = vi.fn(async () => "tool-result");

      await expect(
        mcpActiveUseTracker.trackActiveUse(id, operation),
      ).rejects.toThrow(
        "refusing to run while other replicas may see it as idle",
      );
      await mcpActiveUseTracker.stampIfEnabled(id);
      await drainBackgroundWork();
      expect(updateLastUsed).toHaveBeenCalledWith(id);
      expect(operation).not.toHaveBeenCalled();
      expect(mcpActiveUseTracker.getActiveUseCount(id)).toBe(0);
    });

    test("publishes demand when this replica has hibernation disabled", async () => {
      const id = nextServerId();
      const held = deferred();
      config.orchestrator.mcpIdleHibernation.betaEnabled = false;

      const call = mcpActiveUseTracker.trackActiveUse(id, () => held.promise);
      expect(mcpActiveUseTracker.getActiveUseCount(id)).toBe(1);
      await drainBackgroundWork();

      expect(updateLastUsed).toHaveBeenCalledWith(id);
      held.resolve();
      await call;
    });

    test("heartbeats conservatively when organization lookup fails", async () => {
      const id = nextServerId();
      const held = deferred();
      vi.useFakeTimers();

      const call = mcpActiveUseTracker.trackActiveUse(id, () => held.promise);
      await vi.advanceTimersByTimeAsync(0);
      updateLastUsed.mockClear();
      vi.spyOn(
        OrganizationModel,
        "getMcpIdleHibernationEnabled",
      ).mockRejectedValue(new Error("cache unavailable"));
      mcpActiveUseTracker.start();

      await vi.advanceTimersByTimeAsync(
        MCP_SERVER_LAST_USED_REFRESH_INTERVAL_MS +
          MCP_DEMAND_HEARTBEAT_INTERVAL_MS,
      );
      await drainBackgroundWork();

      expect(updateLastUsed).toHaveBeenCalledWith(id);
      held.resolve();
      await call;
    });

    test("requires cross-replica tracking when hard-disabled locally", async () => {
      const id = nextServerId();
      config.orchestrator.mcpIdleHibernation.hardDisabled = true;
      updateLastUsed.mockRejectedValue(new Error("database unavailable"));

      await expect(
        mcpActiveUseTracker.trackActiveUse(id, async () => "tool-result"),
      ).rejects.toThrow(
        "refusing to run while other replicas may see it as idle",
      );
      await mcpActiveUseTracker.stampIfEnabled(id);
      await drainBackgroundWork();
      expect(updateLastUsed).toHaveBeenCalledWith(id);
      expect(mcpActiveUseTracker.getActiveUseCount(id)).toBe(0);
    });

    test("requires cross-replica tracking without a local license", async () => {
      const id = nextServerId();
      vi.spyOn(enterpriseTier, "isCoreActive").mockReturnValue(false);
      updateLastUsed.mockRejectedValue(new Error("database unavailable"));

      await expect(
        mcpActiveUseTracker.trackActiveUse(id, async () => "tool-result"),
      ).rejects.toThrow(
        "refusing to run while other replicas may see it as idle",
      );
      await mcpActiveUseTracker.stampIfEnabled(id);
      await drainBackgroundWork();
      expect(updateLastUsed).toHaveBeenCalledWith(id);
      expect(mcpActiveUseTracker.getActiveUseCount(id)).toBe(0);
    });

    test("does not add tracking writes or failures when the organization disables hibernation", async () => {
      const id = nextServerId();
      await OrganizationModel.patch(organizationId, {
        mcpIdleHibernationEnabled: false,
      });
      await OrganizationModel.getMcpIdleHibernationEnabled();
      updateLastUsed.mockRejectedValue(new Error("database unavailable"));

      await expect(
        mcpActiveUseTracker.trackActiveUse(id, async () => "tool-result"),
      ).resolves.toBe("tool-result");
      await mcpActiveUseTracker.stampIfEnabled(id);
      await drainBackgroundWork();
      expect(updateLastUsed).not.toHaveBeenCalled();
      expect(mcpActiveUseTracker.getActiveUseCount(id)).toBe(0);
    });

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

  describe("persistence failures", () => {
    test("a failed background write still moves the in-memory watermark", async () => {
      const id = nextServerId();
      updateLastUsed.mockRejectedValue(new Error("database unavailable"));

      mcpActiveUseTracker.stamp(id);
      await drainBackgroundWork();

      // This is the fail-safe the LOCAL sweeper depends on: a dropped
      // persistence write must never make a busy server look idle to the
      // replica that can still see the truth.
      expect(mcpActiveUseTracker.getInMemoryLastUsedAt([id])).not.toBeNull();
      expect(updateLastUsed).toHaveBeenCalledWith(id);
    });

    test("refuses the operation when the entry stamp cannot commit", async () => {
      const id = nextServerId();
      updateLastUsed.mockRejectedValue(new Error("database unavailable"));
      const operation = vi.fn(async () => "tool-result");

      // The entry stamp is the only thing that tells OTHER replicas this
      // server is in use. Running the operation on a failed write would let
      // their sweepers scale the deployment away mid-call, so the operation
      // must be refused up front — retryably, before any dispatch happened.
      await expect(
        mcpActiveUseTracker.trackActiveUse(id, operation),
      ).rejects.toThrow(
        "refusing to run while other replicas may see it as idle",
      );
      await drainBackgroundWork();

      expect(operation).not.toHaveBeenCalled();
      // The refusal releases the slot: nothing keeps counting an operation
      // that never ran.
      expect(mcpActiveUseTracker.getActiveUseCount(id)).toBe(0);
      expect(mcpActiveUseTracker.getInMemoryLastUsedAt([id])).not.toBeNull();
    });

    test("a failed write does not advance the throttle, so the next stamp retries", async () => {
      const id = nextServerId();
      updateLastUsed.mockRejectedValueOnce(new Error("database unavailable"));

      mcpActiveUseTracker.stamp(id);
      await drainBackgroundWork();
      // Same instant, same interval: were the throttle advanced by the failed
      // attempt, this second stamp would be skipped and the row would stay
      // stale for a whole interval nobody actually persisted anything in.
      mcpActiveUseTracker.stamp(id);
      await drainBackgroundWork();

      expect(updateLastUsed).toHaveBeenCalledTimes(2);
    });

    test("concurrent stamps join one in-flight write instead of racing a second", async () => {
      const id = nextServerId();
      const held = deferred();
      updateLastUsed.mockImplementation(() => held.promise);

      mcpActiveUseTracker.stamp(id);
      const awaited = mcpActiveUseTracker.stampAwaited(id);
      held.resolve();
      await awaited;
      await drainBackgroundWork();

      // The awaited stamp joined the write already in flight — and awaited
      // that same commit, because "in flight" is not "committed".
      expect(updateLastUsed).toHaveBeenCalledTimes(1);
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
      // Let the first write COMMIT — the throttle clock starts at the commit,
      // not the attempt.
      await drainBackgroundWork();

      vi.spyOn(Date, "now").mockReturnValue(
        Date.now() + MCP_SERVER_LAST_USED_REFRESH_INTERVAL_MS + 1,
      );
      mcpActiveUseTracker.stamp(id);
      await drainBackgroundWork();

      expect(updateLastUsed).toHaveBeenCalledTimes(2);
    });

    test("a server under sustained traffic keeps persisting, once per interval", async () => {
      // The bug this pins: throttling against the last STAMP instead of the
      // last PERSIST let the window slide forward with the traffic. A server
      // called more often than the interval never opened a gap wide enough to
      // write, so its row froze at the first call — and since every other
      // replica reads only that row, a permanently busy server looked
      // permanently idle to their sweepers and got hibernated mid-traffic.
      const id = nextServerId();
      const start = Date.now();
      const step = MCP_SERVER_LAST_USED_REFRESH_INTERVAL_MS / 3;
      const elapsed = MCP_SERVER_LAST_USED_REFRESH_INTERVAL_MS * 10;
      const now = vi.spyOn(Date, "now");

      for (let offset = 0; offset <= elapsed; offset += step) {
        now.mockReturnValue(start + offset);
        mcpActiveUseTracker.stamp(id);
        // Let each write commit under the clock it was stamped at: the
        // throttle keys on committed persists, and a synchronous burst would
        // otherwise collapse into one shared in-flight write.
        await drainBackgroundWork();
      }

      // Ten intervals of continuous demand: one write per interval, give or
      // take the boundary — emphatically not the single write it used to be.
      expect(updateLastUsed.mock.calls.length).toBeGreaterThanOrEqual(10);
      // And still throttled: one write per stamp would be 31 here.
      expect(updateLastUsed.mock.calls.length).toBeLessThanOrEqual(12);
    });
  });
});

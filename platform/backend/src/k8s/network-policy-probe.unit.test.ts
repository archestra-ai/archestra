import { afterEach, describe, expect, test, vi } from "vitest";
import { networkPolicyProbeReader } from "./network-policy-probe";

// Verdicts age out, so fixtures are dated relative to now rather than pinned.
const RECENTLY = new Date(Date.now() - 60_000).toISOString();

function probePod(role: "control" | "treatment", message?: string) {
  return {
    metadata: { labels: { "archestra.io/netpol-probe-role": role } },
    status: {
      containerStatuses: [
        {
          state: {
            terminated:
              message === undefined
                ? undefined
                : { message, finishedAt: RECENTLY },
          },
        },
      ],
    },
  };
}

function coreApiReturning(items: unknown[]) {
  return {
    listNamespacedPod: vi.fn(async () => ({ items })),
  };
}

describe("network policy enforcement probe", () => {
  afterEach(() => {
    networkPolicyProbeReader.clearCache();
  });

  test("a deny-all that blocks a path the control reached proves enforcement", async () => {
    const coreApi = coreApiReturning([
      probePod("control", "reachable"),
      probePod("treatment", "blocked"),
    ]);

    const verdict = await networkPolicyProbeReader.readVerdict(
      coreApi as never,
      "archestra",
    );

    expect(coreApi.listNamespacedPod).toHaveBeenCalledWith({
      namespace: "archestra",
      labelSelector: "app.kubernetes.io/component=netpol-probe",
    });
    expect(verdict.result).toBe("enforced");
    expect(verdict.probedAt).toBe(RECENTLY);
    expect(verdict.detail).toBe("control=reachable treatment=blocked");
  });

  test("reaching the target through a deny-all proves nothing enforces", async () => {
    const coreApi = coreApiReturning([
      probePod("control", "reachable"),
      probePod("treatment", "reachable"),
    ]);

    const verdict = await networkPolicyProbeReader.readVerdict(
      coreApi as never,
      "archestra",
    );

    expect(verdict.result).toBe("not-enforced");
  });

  test("a control that never reached the target settles nothing either way", async () => {
    const coreApi = coreApiReturning([
      probePod("control", "blocked"),
      probePod("treatment", "blocked"),
    ]);

    const verdict = await networkPolicyProbeReader.readVerdict(
      coreApi as never,
      "archestra",
    );

    // The treatment arm was never offered a path that worked, so its silence
    // carries no information about enforcement.
    expect(verdict.result).toBe("inconclusive");
    expect(verdict.result).not.toBe("enforced");
    expect(verdict.result).not.toBe("not-enforced");
  });

  test.each([
    ["no probe has run", []],
    ["only one arm reported", [probePod("control", "reachable")]],
    [
      "an arm was killed before writing its result",
      [probePod("control", "reachable"), probePod("treatment")],
    ],
    [
      "an arm wrote something unrecognised",
      [probePod("control", "reachable"), probePod("treatment", "¯\\_(ツ)_/¯")],
    ],
  ])("reports absent when %s", async (_case, items) => {
    const verdict = await networkPolicyProbeReader.readVerdict(
      coreApiReturning(items) as never,
      "archestra",
    );

    expect(verdict.result).toBe("absent");
    expect(verdict.probedAt).toBeNull();
  });

  test("a cluster it cannot read is never reported as unenforced", async () => {
    const coreApi = {
      listNamespacedPod: vi.fn().mockRejectedValue({ statusCode: 403 }),
    };

    const verdict = await networkPolicyProbeReader.readVerdict(
      coreApi as never,
      "archestra",
    );

    // Calling a cluster nobody could reach "not enforced" would be a confident
    // claim on no evidence.
    expect(verdict.result).toBe("absent");
    expect(verdict.result).not.toBe("not-enforced");
  });

  test("stops trusting a verdict once it is too old to describe the cluster", async () => {
    const stale = {
      metadata: { labels: { "archestra.io/netpol-probe-role": "treatment" } },
      status: {
        containerStatuses: [
          {
            state: {
              terminated: {
                message: "blocked",
                finishedAt: new Date(
                  Date.now() - 8 * 24 * 60 * 60 * 1000,
                ).toISOString(),
              },
            },
          },
        ],
      },
    };

    const verdict = await networkPolicyProbeReader.readVerdict(
      coreApiReturning([probePod("control", "reachable"), stale]) as never,
      "archestra",
    );

    // An aged "enforced" would keep hiding the warning on a cluster that has
    // since lost enforcement.
    expect(verdict.result).toBe("inconclusive");
    expect(verdict.result).not.toBe("enforced");
  });

  test("answers from the newest run when an old release left its pods behind", async () => {
    const retired = (role: "control" | "treatment", message: string) => ({
      metadata: { labels: { "archestra.io/netpol-probe-role": role } },
      status: {
        containerStatuses: [
          {
            state: {
              terminated: {
                message,
                finishedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
              },
            },
          },
        ],
      },
    });

    const verdict = await networkPolicyProbeReader.readVerdict(
      coreApiReturning([
        // Hook pods survive `helm uninstall`, so both runs can coexist.
        retired("control", "reachable"),
        retired("treatment", "blocked"),
        probePod("control", "reachable"),
        probePod("treatment", "reachable"),
      ]) as never,
      "archestra",
    );

    expect(verdict.result).toBe("not-enforced");
    expect(verdict.probedAt).toBe(RECENTLY);
  });

  test("rechecks sooner while no verdict has landed yet", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T00:00:00.000Z"));
    const coreApi = coreApiReturning([]);

    await networkPolicyProbeReader.readVerdict(coreApi as never, "archestra");
    vi.advanceTimersByTime(31_000);
    await networkPolicyProbeReader.readVerdict(coreApi as never, "archestra");

    // The probe reports after the platform is already up, so a pending result
    // must not be held for the full interval.
    expect(coreApi.listNamespacedPod).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  test("caches the verdict per API client", async () => {
    const coreApi = coreApiReturning([
      probePod("control", "reachable"),
      probePod("treatment", "blocked"),
    ]);

    await networkPolicyProbeReader.readVerdict(coreApi as never, "archestra");
    await networkPolicyProbeReader.readVerdict(coreApi as never, "archestra");

    expect(coreApi.listNamespacedPod).toHaveBeenCalledTimes(1);
  });
});

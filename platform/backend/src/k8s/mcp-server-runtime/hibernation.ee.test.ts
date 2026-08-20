// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

/**
 * The two pure pieces of the hibernation lifecycle: the gate (given the
 * organization's master toggle and the per-install modes of a sibling group,
 * may that group sleep?) and the deadline wrapper that keeps a hung wake or
 * sweep from wedging the runtime.
 *
 * The sweeper's own behaviour is covered through the manager seams
 * (manager.test.ts) and end to end against a fake cluster
 * (manager-deployment-integration.test.ts). What is exhaustively enumerated
 * here is the truth table itself, because getting one cell wrong either keeps
 * a fleet awake (a silent cost regression nobody notices) or scales away a
 * server an administrator explicitly pinned up.
 */
import { describe, expect, test, vi } from "@/test";
import type { McpServerHibernationMode } from "@/types";
import { isGroupHibernationAllowed, withDeadline } from "./hibernation.ee";

const ALL_MODES: McpServerHibernationMode[] = [
  "inherit",
  "enabled",
  "disabled",
];

describe("isGroupHibernationAllowed", () => {
  test("the organization toggle is the master switch: off means nothing sleeps", () => {
    // Including a group that has explicitly opted IN. "enabled" pins an
    // install's intent; it is never a way around an administrator's off.
    for (const mode of ALL_MODES) {
      expect(
        isGroupHibernationAllowed({
          organizationEnabled: false,
          modes: [mode],
        }),
      ).toBe(false);
    }
    expect(
      isGroupHibernationAllowed({
        organizationEnabled: false,
        modes: ["enabled", "enabled"],
      }),
    ).toBe(false);
  });

  test("with the organization on, 'inherit' and 'enabled' both sleep", () => {
    expect(
      isGroupHibernationAllowed({
        organizationEnabled: true,
        modes: ["inherit"],
      }),
    ).toBe(true);
    expect(
      isGroupHibernationAllowed({
        organizationEnabled: true,
        modes: ["enabled"],
      }),
    ).toBe(true);
    expect(
      isGroupHibernationAllowed({
        organizationEnabled: true,
        modes: ["inherit", "enabled", "inherit"],
      }),
    ).toBe(true);
  });

  test("a single 'disabled' install vetoes its whole multitenant group", () => {
    // Every sibling install of a multitenant catalog runs on ONE pod, so
    // "keep me awake" can only be honoured by keeping all of them awake.
    const mixes: McpServerHibernationMode[][] = [
      ["disabled"],
      ["disabled", "inherit"],
      ["inherit", "disabled"],
      ["enabled", "disabled"],
      ["disabled", "enabled", "inherit"],
      ["inherit", "inherit", "disabled", "enabled"],
    ];
    for (const modes of mixes) {
      expect(
        isGroupHibernationAllowed({ organizationEnabled: true, modes }),
      ).toBe(false);
    }
  });

  test("a group whose rows vanished mid-sweep follows the organization alone", () => {
    // An empty projection means the installs were deleted between resolving
    // the group and reading its modes. Nothing is pinned awake, so the org
    // toggle decides — and the caller's own "no usage signal" guard is what
    // actually stops a vanished group from being hibernated.
    expect(
      isGroupHibernationAllowed({ organizationEnabled: true, modes: [] }),
    ).toBe(true);
    expect(
      isGroupHibernationAllowed({ organizationEnabled: false, modes: [] }),
    ).toBe(false);
  });

  test("every combination of one organization state and two install modes", () => {
    // Exhaustive: the contract is "org on AND no sibling disabled", and this
    // is the whole table it has to satisfy.
    for (const organizationEnabled of [true, false]) {
      for (const first of ALL_MODES) {
        for (const second of ALL_MODES) {
          const expected =
            organizationEnabled &&
            first !== "disabled" &&
            second !== "disabled";
          expect(
            isGroupHibernationAllowed({
              organizationEnabled,
              modes: [first, second],
            }),
          ).toBe(expected);
        }
      }
    }
  });
});

describe("withDeadline", () => {
  test("settles with the work's own value when the work wins", async () => {
    await expect(
      withDeadline(Promise.resolve("awake"), 60_000, () => new Error("late")),
    ).resolves.toBe("awake");
  });

  test("settles with the work's own rejection when the work wins", async () => {
    // The deadline is a catch-all, not a rewriter: the reason a wake actually
    // failed is the only thing a caller (or an operator reading the log) can
    // act on, so it has to survive the wrapper untouched.
    const failure = new Error("deployment did not become ready");
    await expect(
      withDeadline(Promise.reject(failure), 60_000, () => new Error("late")),
    ).rejects.toBe(failure);
  });

  test("rejects with the supplied error once the deadline elapses", async () => {
    vi.useFakeTimers();
    try {
      const deadlineError = new Error("the attempt did not settle in time");
      let outcome: unknown;
      // Work that never settles: the wedge the deadline exists to survive.
      const guarded = withDeadline(
        new Promise<string>(() => {}),
        30_000,
        () => deadlineError,
      ).then(
        (value) => {
          outcome = value;
        },
        (error) => {
          outcome = error;
        },
      );

      await vi.advanceTimersByTimeAsync(29_999);
      expect(outcome).toBeUndefined();

      await vi.advanceTimersByTimeAsync(1);
      await guarded;
      expect(outcome).toBe(deadlineError);
    } finally {
      vi.useRealTimers();
    }
  });

  test("work that settles after its deadline changes nothing and never becomes an unhandled rejection", async () => {
    vi.useFakeTimers();
    try {
      // Nothing cancels the underlying work, so a hung Kubernetes call can
      // still finish — or fail — minutes after its caller was released. A
      // late rejection with no handler attached would take the process down
      // under strict unhandled-rejection settings; this run fails on one.
      let settleLate: (value: string) => void = () => {};
      let failLate: (error: Error) => void = () => {};
      const settledLate = withDeadline(
        new Promise<string>((resolve) => {
          settleLate = resolve;
        }),
        10_000,
        () => new Error("deadline"),
      ).then(
        (value) => value,
        (error) => error,
      );
      const failedLate = withDeadline(
        new Promise<string>((_resolve, reject) => {
          failLate = reject;
        }),
        10_000,
        () => new Error("deadline"),
      ).then(
        (value) => value,
        (error) => error,
      );

      await vi.advanceTimersByTimeAsync(10_000);
      const settledLateOutcome = await settledLate;
      const failedLateOutcome = await failedLate;
      expect(settledLateOutcome).toMatchObject({ message: "deadline" });
      expect(failedLateOutcome).toMatchObject({ message: "deadline" });

      settleLate("too late");
      failLate(new Error("also too late"));
      await vi.advanceTimersByTimeAsync(0);

      expect(await settledLate).toBe(settledLateOutcome);
      expect(await failedLate).toBe(failedLateOutcome);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a pending deadline never holds the event loop open on its own", async () => {
    // The sweep deadline is five minutes long. Left ref'd, that handle keeps
    // a Node process alive for five minutes after the work it guards was
    // abandoned — and a test worker with it.
    const realSetTimeout = globalThis.setTimeout;
    const handles: NodeJS.Timeout[] = [];
    vi.stubGlobal("setTimeout", ((handler: () => void, ms?: number) => {
      const handle = realSetTimeout(handler, ms);
      handles.push(handle);
      return handle;
    }) as unknown as typeof globalThis.setTimeout);

    let settleWork: (value: string) => void = () => {};
    const guarded = withDeadline(
      new Promise<string>((resolve) => {
        settleWork = resolve;
      }),
      60_000,
      () => new Error("late"),
    );

    expect(handles).toHaveLength(1);
    expect(handles[0]?.hasRef()).toBe(false);

    settleWork("awake");
    await expect(guarded).resolves.toBe("awake");
  });
});

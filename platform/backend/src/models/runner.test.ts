import { describe, expect } from "vitest";
import { RunnerEventModel, RunnerModel } from "@/models";
import { test } from "@/test";
import type { InsertRunner } from "@/types";

async function seedRunner(
  makeOrganization: () => Promise<{ id: string }>,
  makeUser: (o?: Record<string, unknown>) => Promise<{ id: string }>,
  makeAgent: (o?: Record<string, unknown>) => Promise<{ id: string }>,
  overrides: Partial<InsertRunner> = {},
) {
  const org = await makeOrganization();
  const user = await makeUser();
  const agent = await makeAgent({ organizationId: org.id });
  return RunnerModel.create({
    organizationId: org.id,
    agentId: agent.id,
    createdByUserId: user.id,
    name: "Test runner",
    image: "ghcr.io/example/runner:latest",
    ...overrides,
  });
}

describe("RunnerModel", () => {
  test("findById refuses a runner from another organization", async ({
    makeOrganization,
    makeUser,
    makeAgent,
  }) => {
    const runner = await seedRunner(makeOrganization, makeUser, makeAgent);
    const otherOrg = await makeOrganization();

    expect(
      await RunnerModel.findById(runner.id, runner.organizationId),
    ).not.toBeNull();
    expect(await RunnerModel.findById(runner.id, otherOrg.id)).toBeNull();
  });

  test("transition from an expected state stamps startedAt and activity", async ({
    makeOrganization,
    makeUser,
    makeAgent,
  }) => {
    const runner = await seedRunner(makeOrganization, makeUser, makeAgent);

    const running = await RunnerModel.transition({
      id: runner.id,
      organizationId: runner.organizationId,
      to: "running",
      from: ["pending", "provisioning"],
    });

    expect(running?.state).toBe("running");
    expect(running?.startedAt).toBeInstanceOf(Date);
    expect(running?.lastActivityAt).toBeInstanceOf(Date);
  });

  test("transition is a no-op when the runner left the expected state", async ({
    makeOrganization,
    makeUser,
    makeAgent,
  }) => {
    const runner = await seedRunner(makeOrganization, makeUser, makeAgent);
    await RunnerModel.transition({
      id: runner.id,
      organizationId: runner.organizationId,
      to: "stopped",
    });

    // A reconciler pass racing a user's stop must lose rather than resurrect
    // the runner into `running`.
    const late = await RunnerModel.transition({
      id: runner.id,
      organizationId: runner.organizationId,
      to: "running",
      from: ["pending", "provisioning"],
    });

    expect(late).toBeNull();
    const current = await RunnerModel.findById(
      runner.id,
      runner.organizationId,
    );
    expect(current?.state).toBe("stopped");
  });

  test("transition to a terminal state stamps stoppedAt and the reason", async ({
    makeOrganization,
    makeUser,
    makeAgent,
  }) => {
    const runner = await seedRunner(makeOrganization, makeUser, makeAgent);

    const failed = await RunnerModel.transition({
      id: runner.id,
      organizationId: runner.organizationId,
      to: "failed",
      statusReason: "image pull failed",
    });

    expect(failed?.state).toBe("failed");
    expect(failed?.statusReason).toBe("image pull failed");
    expect(failed?.stoppedAt).toBeInstanceOf(Date);
  });

  test("listExpired returns runners past their TTL but not fresh ones", async ({
    makeOrganization,
    makeUser,
    makeAgent,
  }) => {
    const expired = await seedRunner(makeOrganization, makeUser, makeAgent, {
      ttlHours: 1,
    });
    const fresh = await seedRunner(makeOrganization, makeUser, makeAgent, {
      ttlHours: 24,
    });
    for (const runner of [expired, fresh]) {
      await RunnerModel.transition({
        id: runner.id,
        organizationId: runner.organizationId,
        to: "running",
      });
    }

    // Two hours on: the 1h TTL has elapsed, the 24h one has not.
    const now = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const ids = (await RunnerModel.listExpired(now)).map((row) => row.id);

    expect(ids).toContain(expired.id);
    expect(ids).not.toContain(fresh.id);
  });

  test("listExpired returns runners idle past their timeout", async ({
    makeOrganization,
    makeUser,
    makeAgent,
  }) => {
    const runner = await seedRunner(makeOrganization, makeUser, makeAgent, {
      idleTimeoutMinutes: 30,
    });
    await RunnerModel.transition({
      id: runner.id,
      organizationId: runner.organizationId,
      to: "running",
    });

    const now = new Date(Date.now() + 60 * 60 * 1000);
    const ids = (await RunnerModel.listExpired(now)).map((row) => row.id);
    expect(ids).toContain(runner.id);

    // A steer resets the idle clock, so the same instant no longer expires it.
    await RunnerModel.touchActivity(runner.id);
    const afterTouch = (await RunnerModel.listExpired(new Date())).map(
      (row) => row.id,
    );
    expect(afterTouch).not.toContain(runner.id);
  });

  test("a stopped runner is never reported as expired", async ({
    makeOrganization,
    makeUser,
    makeAgent,
  }) => {
    const runner = await seedRunner(makeOrganization, makeUser, makeAgent, {
      ttlHours: 1,
    });
    await RunnerModel.transition({
      id: runner.id,
      organizationId: runner.organizationId,
      to: "stopped",
    });

    const now = new Date(Date.now() + 5 * 60 * 60 * 1000);
    const ids = (await RunnerModel.listExpired(now)).map((row) => row.id);
    expect(ids).not.toContain(runner.id);
  });

  test("listLiveDeploymentNames covers only runners expected to own a workload", async ({
    makeOrganization,
    makeUser,
    makeAgent,
  }) => {
    const live = await seedRunner(makeOrganization, makeUser, makeAgent, {
      deploymentName: "runner-live",
    });
    const gone = await seedRunner(makeOrganization, makeUser, makeAgent, {
      deploymentName: "runner-gone",
    });
    await RunnerModel.transition({
      id: live.id,
      organizationId: live.organizationId,
      to: "running",
    });
    await RunnerModel.transition({
      id: gone.id,
      organizationId: gone.organizationId,
      to: "stopped",
    });

    const names = await RunnerModel.listLiveDeploymentNames();
    expect(names).toContain("runner-live");
    expect(names).not.toContain("runner-gone");
  });
});

describe("RunnerEventModel", () => {
  test("concurrent appends receive distinct ordered sequences", async ({
    makeOrganization,
    makeUser,
    makeAgent,
  }) => {
    const runner = await seedRunner(makeOrganization, makeUser, makeAgent);

    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        RunnerEventModel.append({
          runnerId: runner.id,
          kind: "steer",
          message: `steer ${index}`,
        }),
      ),
    );

    const events = await RunnerEventModel.listForRunner(runner.id);
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4]);
  });

  test("deleting a runner removes its timeline", async ({
    makeOrganization,
    makeUser,
    makeAgent,
  }) => {
    const runner = await seedRunner(makeOrganization, makeUser, makeAgent);
    await RunnerEventModel.append({
      runnerId: runner.id,
      kind: "system",
      message: "provisioned",
    });

    await RunnerModel.delete(runner.id, runner.organizationId);

    expect(await RunnerEventModel.listForRunner(runner.id)).toEqual([]);
  });
});

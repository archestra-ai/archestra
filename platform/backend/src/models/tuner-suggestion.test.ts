import { describe, expect, type TestFixtures, test } from "@/test";
import {
  type TunerCandidate,
  type TunerSeverity,
  tunerFingerprint,
} from "@/types/tuner";
import TunerSuggestionModel from "./tuner-suggestion";

const now = new Date("2026-11-16T12:00:00Z");

function candidate(
  severity: TunerSeverity = "warn",
  name = "api",
): TunerCandidate {
  return {
    fingerprint: tunerFingerprint(
      "sre_restart_loop",
      "default",
      "Deployment",
      name,
    ),
    source: "sre_restart_loop",
    severity,
    title: `${name} restarts`,
    detail: "6 restarts",
    evidence: [
      { type: "k8s_workload", namespace: "default", kind: "Deployment", name },
    ],
  };
}

describe("TunerSuggestionModel", () => {
  async function setup({
    makeScheduleTrigger,
    makeScheduleTriggerRun,
    makeOrganization,
    makeUser,
  }: Pick<
    TestFixtures,
    | "makeScheduleTrigger"
    | "makeScheduleTriggerRun"
    | "makeOrganization"
    | "makeUser"
  >) {
    const organization = await makeOrganization();
    const user = await makeUser();
    const trigger = await makeScheduleTrigger({
      organizationId: organization.id,
      actorUserId: user.id,
    });
    const run = await makeScheduleTriggerRun(trigger.id);
    const propose = (c: TunerCandidate, at = now) =>
      TunerSuggestionModel.propose({
        organizationId: organization.id,
        tunerKind: "sre",
        candidate: c,
        rationale: "why",
        action: { type: "note" },
        scheduleTriggerRunId: run.id,
        now: at,
      });
    return { organizationId: organization.id, userId: user.id, propose };
  }

  test("keeps one open suggestion per fingerprint", async ({
    makeScheduleTrigger,
    makeScheduleTriggerRun,
    makeOrganization,
    makeUser,
  }) => {
    const fixtures = {
      makeScheduleTrigger,
      makeScheduleTriggerRun,
      makeOrganization,
      makeUser,
    };
    const { propose, organizationId } = await setup(fixtures);

    const first = await propose(candidate("warn"));
    const second = await propose(candidate("warn"));

    expect(first.type).toBe("created");
    expect(second).toEqual({ type: "suppressed", reason: "open_suggestion" });
    const open = await TunerSuggestionModel.list({
      organizationId,
      statuses: ["open"],
      pagination: { limit: 10, offset: 0 },
    });
    expect(open.data).toHaveLength(1);
  });

  test("a higher severity supersedes the open suggestion", async ({
    makeScheduleTrigger,
    makeScheduleTriggerRun,
    makeOrganization,
    makeUser,
  }) => {
    const fixtures = {
      makeScheduleTrigger,
      makeScheduleTriggerRun,
      makeOrganization,
      makeUser,
    };
    const { propose, organizationId } = await setup(fixtures);
    const first = await propose(candidate("warn"));
    if (first.type !== "created") throw new Error("expected created");

    const second = await propose(candidate("critical"));

    expect(second.type).toBe("created");
    const old = await TunerSuggestionModel.findById({
      id: first.suggestion.id,
      organizationId,
    });
    expect(old?.status).toBe("resolved");
    const open = await TunerSuggestionModel.list({
      organizationId,
      statuses: ["open"],
      pagination: { limit: 10, offset: 0 },
    });
    expect(open.data.map((s) => s.severity)).toEqual(["critical"]);
  });

  test("only one of two admin actions on an open suggestion wins", async ({
    makeScheduleTrigger,
    makeScheduleTriggerRun,
    makeOrganization,
    makeUser,
  }) => {
    const fixtures = {
      makeScheduleTrigger,
      makeScheduleTriggerRun,
      makeOrganization,
      makeUser,
    };
    const { propose, organizationId, userId } = await setup(fixtures);
    const created = await propose(candidate());
    if (created.type !== "created") throw new Error("expected created");
    const id = created.suggestion.id;

    const claimed = await TunerSuggestionModel.claimForApply({
      id,
      organizationId,
      userId,
    });
    const closed = await TunerSuggestionModel.close({
      id,
      organizationId,
      userId,
      status: "done",
      comment: null,
    });
    const claimedAgain = await TunerSuggestionModel.claimForApply({
      id,
      organizationId,
      userId,
    });

    expect(claimed?.status).toBe("published");
    expect(closed).toBeNull();
    expect(claimedAgain).toBeNull();
  });

  test("a superseded suggestion can no longer be applied", async ({
    makeScheduleTrigger,
    makeScheduleTriggerRun,
    makeOrganization,
    makeUser,
  }) => {
    const fixtures = {
      makeScheduleTrigger,
      makeScheduleTriggerRun,
      makeOrganization,
      makeUser,
    };
    const { propose, organizationId, userId } = await setup(fixtures);
    const first = await propose(candidate("info"));
    if (first.type !== "created") throw new Error("expected created");
    await propose(candidate("warn"));

    const claimed = await TunerSuggestionModel.claimForApply({
      id: first.suggestion.id,
      organizationId,
      userId,
    });

    expect(claimed).toBeNull();
  });

  test("a published change blocks new proposals until released", async ({
    makeScheduleTrigger,
    makeScheduleTriggerRun,
    makeOrganization,
    makeUser,
  }) => {
    const fixtures = {
      makeScheduleTrigger,
      makeScheduleTriggerRun,
      makeOrganization,
      makeUser,
    };
    const { propose, organizationId, userId } = await setup(fixtures);
    const created = await propose(candidate());
    if (created.type !== "created") throw new Error("expected created");
    await TunerSuggestionModel.claimForApply({
      id: created.suggestion.id,
      organizationId,
      userId,
    });

    expect(await propose(candidate("critical"))).toEqual({
      type: "suppressed",
      reason: "change_in_flight",
    });

    const released = await TunerSuggestionModel.releaseClaim({
      id: created.suggestion.id,
      organizationId,
    });
    expect(released?.status).toBe("open");
  });

  test("done and rejected suppress the fingerprint; a higher severity re-opens", async ({
    makeScheduleTrigger,
    makeScheduleTriggerRun,
    makeOrganization,
    makeUser,
  }) => {
    const fixtures = {
      makeScheduleTrigger,
      makeScheduleTriggerRun,
      makeOrganization,
      makeUser,
    };
    const { propose, organizationId, userId } = await setup(fixtures);
    const created = await propose(candidate("warn"));
    if (created.type !== "created") throw new Error("expected created");
    await TunerSuggestionModel.close({
      id: created.suggestion.id,
      organizationId,
      userId,
      status: "rejected",
      comment: "expected behaviour",
    });

    expect(await propose(candidate("warn"))).toEqual({
      type: "suppressed",
      reason: "recently_closed",
    });
    expect((await propose(candidate("critical"))).type).toBe("created");
  });

  test("resolveVanished resolves only open suggestions of the tuner that are gone", async ({
    makeScheduleTrigger,
    makeScheduleTriggerRun,
    makeOrganization,
    makeUser,
  }) => {
    const fixtures = {
      makeScheduleTrigger,
      makeScheduleTriggerRun,
      makeOrganization,
      makeUser,
    };
    const { propose, organizationId, userId } = await setup(fixtures);
    const gone = await propose(candidate("warn", "gone"));
    const kept = await propose(candidate("warn", "kept"));
    const closed = await propose(candidate("warn", "closed"));
    if (
      gone.type !== "created" ||
      kept.type !== "created" ||
      closed.type !== "created"
    ) {
      throw new Error("expected created");
    }
    await TunerSuggestionModel.close({
      id: closed.suggestion.id,
      organizationId,
      userId,
      status: "done",
      comment: null,
    });

    const resolved = await TunerSuggestionModel.resolveVanished({
      organizationId,
      tunerKind: "sre",
      present: [kept.suggestion.fingerprint],
      now,
    });

    expect(resolved).toBe(1);
    const statuses = await Promise.all(
      [gone, kept, closed].map(async (r) =>
        r.type === "created"
          ? (
              await TunerSuggestionModel.findById({
                id: r.suggestion.id,
                organizationId,
              })
            )?.status
          : null,
      ),
    );
    expect(statuses).toEqual(["resolved", "open", "done"]);
  });

  test("recentByFingerprint returns at most N per fingerprint, newest first", async ({
    makeScheduleTrigger,
    makeScheduleTriggerRun,
    makeOrganization,
    makeUser,
  }) => {
    const fixtures = {
      makeScheduleTrigger,
      makeScheduleTriggerRun,
      makeOrganization,
      makeUser,
    };
    const { propose, organizationId, userId } = await setup(fixtures);
    for (const severity of ["info", "warn", "critical"] as const) {
      const created = await propose(candidate(severity));
      if (created.type !== "created") throw new Error("expected created");
      if (severity !== "critical") continue;
      await TunerSuggestionModel.close({
        id: created.suggestion.id,
        organizationId,
        userId,
        status: "done",
        comment: null,
      });
    }

    const recent = await TunerSuggestionModel.recentByFingerprint({
      organizationId,
      fingerprints: [candidate().fingerprint],
      perFingerprint: 2,
    });

    expect(recent.map((s) => s.severity)).toEqual(["critical", "warn"]);
  });

  test("never touches another organization's suggestions", async ({
    makeScheduleTrigger,
    makeScheduleTriggerRun,
    makeOrganization,
    makeUser,
  }) => {
    const fixtures = {
      makeScheduleTrigger,
      makeScheduleTriggerRun,
      makeOrganization,
      makeUser,
    };
    const a = await setup(fixtures);
    const b = await setup(fixtures);
    const created = await a.propose(candidate());
    if (created.type !== "created") throw new Error("expected created");

    expect((await b.propose(candidate())).type).toBe("created");
    expect(
      await TunerSuggestionModel.close({
        id: created.suggestion.id,
        organizationId: b.organizationId,
        userId: b.userId,
        status: "done",
        comment: null,
      }),
    ).toBeNull();
  });
});

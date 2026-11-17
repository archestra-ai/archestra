import { ADMIN_ROLE_NAME, BUILT_IN_AGENT_IDS } from "@archestra/shared";
import config from "@/config";
import db, { schema } from "@/database";
import { ScheduleTriggerRunModel, TunerSuggestionModel } from "@/models";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type TestFixtures,
  test,
} from "@/test";
import { TunerFingerprintSchema, type TunerKind } from "@/types/tuner";
import { runTunerPreflight } from "./preflight";

const DENIED_TOOL = "shell__exec";
const DENIED_FINGERPRINT = "appa_repeated_denials:mcp/shell/exec";

describe("runTunerPreflight", () => {
  const saved = {
    tuners: config.tuners.enabled,
    openappa: config.openappa.enabled,
  };
  beforeEach(() => {
    config.tuners.enabled = true;
    config.openappa.enabled = true;
  });
  afterEach(() => {
    config.tuners.enabled = saved.tuners;
    config.openappa.enabled = saved.openappa;
  });

  test("with nothing found, settles the run without the agent", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeScheduleTrigger,
    makeScheduleTriggerRun,
  }) => {
    const tuner = await appaTuner({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      makeScheduleTrigger,
      makeScheduleTriggerRun,
    });

    expect(await preflight(tuner)).toEqual({
      type: "settled",
      outcome: "no_candidates",
    });
    expect(await recordOf(tuner.runId)).toEqual({
      outcome: "no_candidates",
      candidates: [],
    });
  });

  test("hands fresh candidates to the agent and records them on the run", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeScheduleTrigger,
    makeScheduleTriggerRun,
  }) => {
    const tuner = await appaTuner({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      makeScheduleTrigger,
      makeScheduleTriggerRun,
    });
    await seedDenials(tuner.organizationId);

    expect(await preflight(tuner)).toMatchObject({ type: "run_agent" });
    const record = await recordOf(tuner.runId);
    expect(record?.outcome).toBe("agent_ran");
    expect(record?.candidates.map((c) => c.fingerprint)).toEqual([
      DENIED_FINGERPRINT,
    ]);
  });

  test("an open suggestion for the same issue suppresses it", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeScheduleTrigger,
    makeScheduleTriggerRun,
  }) => {
    const tuner = await appaTuner({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      makeScheduleTrigger,
      makeScheduleTriggerRun,
    });
    await seedDenials(tuner.organizationId);
    const earlier = await makeScheduleTriggerRun(tuner.trigger.id);
    await fileSuggestion({ ...tuner, runId: earlier.id });

    expect(await preflight(tuner)).toEqual({
      type: "settled",
      outcome: "all_suppressed",
    });
    expect(await recordOf(tuner.runId)).toEqual({
      outcome: "all_suppressed",
      candidates: [],
    });
  });

  test("resolves an open suggestion whose issue is gone", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeScheduleTrigger,
    makeScheduleTriggerRun,
  }) => {
    const tuner = await appaTuner({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      makeScheduleTrigger,
      makeScheduleTriggerRun,
    });
    const earlier = await makeScheduleTriggerRun(tuner.trigger.id);
    const filed = await fileSuggestion({ ...tuner, runId: earlier.id });

    await preflight(tuner);

    const after = await TunerSuggestionModel.findById({
      id: filed,
      organizationId: tuner.organizationId,
    });
    expect(after?.status).toBe("resolved");
  });

  test("a redelivered run resumes from its recorded scan", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeScheduleTrigger,
    makeScheduleTriggerRun,
  }) => {
    const tuner = await appaTuner({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      makeScheduleTrigger,
      makeScheduleTriggerRun,
    });
    await preflight(tuner);
    await seedDenials(tuner.organizationId);

    expect(await preflight(tuner)).toEqual({
      type: "settled",
      outcome: "no_candidates",
    });
    expect(await recordOf(tuner.runId)).toEqual({
      outcome: "no_candidates",
      candidates: [],
    });

    const later = await appaTuner({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      makeScheduleTrigger,
      makeScheduleTriggerRun,
    });
    await seedDenials(later.organizationId);
    await preflight(later);
    expect(await preflight(later)).toMatchObject({ type: "run_agent" });
  });

  test("hands the agent at most 25 candidates, most severe first", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeScheduleTrigger,
    makeScheduleTriggerRun,
  }) => {
    const tuner = await appaTuner({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      makeScheduleTrigger,
      makeScheduleTriggerRun,
    });
    for (let index = 0; index < 26; index += 1) {
      await seedDenials(tuner.organizationId, `tool_${index}`);
    }
    for (let round = 0; round < 3; round += 1) {
      await seedDenials(tuner.organizationId, "tool_25");
    }

    await preflight(tuner);

    const record = await recordOf(tuner.runId);
    expect(record?.candidates).toHaveLength(25);
    expect(record?.candidates[0]).toMatchObject({
      fingerprint: "appa_repeated_denials:host/archestra/tool_25",
      severity: "critical",
    });
  });

  test("fails closed before scanning", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeScheduleTrigger,
    makeScheduleTriggerRun,
  }) => {
    const fixtures = {
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      makeScheduleTrigger,
      makeScheduleTriggerRun,
    };

    const memberActor = await appaTuner({ ...fixtures, actorRole: "member" });
    await expect(preflight(memberActor)).rejects.toThrow();
    expect(await recordOf(memberActor.runId)).toBeNull();

    const otherAgent = await appaTuner(fixtures);
    const stranger = await makeAgent({
      agentType: "agent",
      organizationId: otherAgent.organizationId,
    });
    await expect(
      preflight({
        ...otherAgent,
        trigger: { ...otherAgent.trigger, agentId: stranger.id },
      }),
    ).rejects.toThrow();
    expect(await recordOf(otherAgent.runId)).toBeNull();

    const inRuntime = await appaTuner(fixtures);
    await expect(
      preflight(inRuntime, { agentHasRuntime: true }),
    ).rejects.toThrow();
    expect(await recordOf(inRuntime.runId)).toBeNull();

    const flagOff = await appaTuner(fixtures);
    config.tuners.enabled = false;
    await expect(preflight(flagOff)).rejects.toThrow();
    expect(await recordOf(flagOff.runId)).toBeNull();
  });
});

type TunerSetup = Awaited<ReturnType<typeof appaTuner>>;

async function appaTuner(
  params: Pick<
    TestFixtures,
    | "makeOrganization"
    | "makeUser"
    | "makeMember"
    | "makeAgent"
    | "makeScheduleTrigger"
    | "makeScheduleTriggerRun"
  > & { actorRole?: string },
) {
  const organization = await params.makeOrganization();
  const actor = await params.makeUser();
  await params.makeMember(actor.id, organization.id, {
    role: params.actorRole ?? ADMIN_ROLE_NAME,
  });
  const agent = await params.makeAgent({
    agentType: "agent",
    organizationId: organization.id,
    builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.APPA_TUNER },
  });
  const trigger = await params.makeScheduleTrigger({
    organizationId: organization.id,
    actorUserId: actor.id,
    agentId: agent.id,
    tunerKind: "appa",
  });
  const run = await params.makeScheduleTriggerRun(trigger.id);
  return {
    organizationId: organization.id,
    trigger: { ...trigger, tunerKind: "appa" as TunerKind },
    runId: run.id,
  };
}

function preflight(
  tuner: TunerSetup,
  options: { agentHasRuntime?: boolean } = {},
) {
  return runTunerPreflight({
    runId: tuner.runId,
    trigger: tuner.trigger,
    agentHasRuntime: options.agentHasRuntime ?? false,
    now: new Date(),
  });
}

async function recordOf(runId: string) {
  return (await ScheduleTriggerRunModel.findById(runId))?.tuner ?? null;
}

/** Five policy denials of one tool across two sessions: one candidate. */
async function seedDenials(organizationId: string, tool = DENIED_TOOL) {
  for (const [index, session] of ["s1", "s1", "s1", "s2", "s2"].entries()) {
    await db.insert(schema.openappaOperationsTable).values({
      organizationId,
      sessionId: session,
      operationId: `call:${crypto.randomUUID()}`,
      root: "root",
      status: "complete",
      input: { semantic: { event: "tool_call", tool } },
      decision: { decision: "deny_call", offers: [] },
      createdAt: new Date(Date.now() - (index + 1) * 60 * 60 * 1000),
    });
  }
}

async function fileSuggestion(params: {
  organizationId: string;
  runId: string;
}): Promise<string> {
  const result = await TunerSuggestionModel.propose({
    organizationId: params.organizationId,
    tunerKind: "appa",
    candidate: {
      fingerprint: TunerFingerprintSchema.parse(DENIED_FINGERPRINT),
      source: "appa_repeated_denials",
      severity: "warn",
      title: "Denied tool",
      detail: "Denied often",
      evidence: [],
    },
    rationale: "Earlier run",
    action: { type: "note" },
    scheduleTriggerRunId: params.runId,
    now: new Date(),
  });
  if (result.type !== "created") throw new Error("expected a new suggestion");
  return result.suggestion.id;
}

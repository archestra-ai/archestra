import {
  ADMIN_ROLE_NAME,
  AGENT_TOOL_PREFIX,
  BUILT_IN_AGENT_IDS,
  getArchestraToolFullName,
  SKILL_TOOL_PREFIX,
} from "@archestra/shared";
import config from "@/config";
import {
  ScheduleTriggerModel,
  ScheduleTriggerRunModel,
  TunerSuggestionModel,
} from "@/models";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type TestFixtures,
  test,
} from "@/test";
import { type TunerCandidate, TunerFingerprintSchema } from "@/types/tuner";
import { type ArchestraContext, executeArchestraTool } from ".";
import { tunerRunToolFilter } from "./tuner-run-admission";

const PROPOSE = getArchestraToolFullName("propose_tuner_suggestion");
const CANDIDATE: TunerCandidate = {
  fingerprint: TunerFingerprintSchema.parse(
    "appa_repeated_denials:shell__exec",
  ),
  source: "appa_repeated_denials",
  severity: "warn",
  title: "Denied tool",
  detail: "Denied often",
  evidence: [],
};

describe("propose_tuner_suggestion", () => {
  const saved = config.tuners.enabled;
  beforeEach(() => {
    config.tuners.enabled = true;
  });
  afterEach(() => {
    config.tuners.enabled = saved;
  });

  test("files a candidate of the run once, then reports it covered", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeScheduleTrigger,
    makeScheduleTriggerRun,
  }) => {
    const { context, organizationId } = await tunerRun({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      makeScheduleTrigger,
      makeScheduleTriggerRun,
    });

    const first = await propose(context, CANDIDATE.fingerprint);
    const second = await propose(context, CANDIDATE.fingerprint);

    expect(first.isError).toBeFalsy();
    expect(first.structuredContent).toMatchObject({ status: "created" });
    expect(second.structuredContent).toMatchObject({ status: "suppressed" });
    const filed = await TunerSuggestionModel.list({
      organizationId,
      pagination: { limit: 10, offset: 0 },
    });
    expect(filed.data.map((s) => s.fingerprint)).toEqual([
      CANDIDATE.fingerprint,
    ]);
  });

  test("refuses what the run did not find, a finished run, and another agent", async ({
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
    const unknown = await tunerRun(fixtures);
    expect(
      (await propose(unknown.context, "appa_repeated_denials:other")).isError,
    ).toBe(true);

    const otherAgent = await tunerRun(fixtures);
    const stranger = await makeAgent({
      agentType: "agent",
      organizationId: otherAgent.organizationId,
    });
    expect(
      (
        await propose(
          {
            ...otherAgent.context,
            agent: { id: stranger.id, name: stranger.name },
            agentId: stranger.id,
          },
          CANDIDATE.fingerprint,
        )
      ).isError,
    ).toBe(true);

    const finished = await tunerRun(fixtures);
    await ScheduleTriggerRunModel.markCompleted({
      runId: finished.runId,
      status: "success",
    });
    expect(
      (await propose(finished.context, CANDIDATE.fingerprint)).isError,
    ).toBe(true);

    for (const { organizationId } of [unknown, otherAgent, finished]) {
      const filed = await TunerSuggestionModel.list({
        organizationId,
        pagination: { limit: 10, offset: 0 },
      });
      expect(filed.data).toEqual([]);
    }
  });

  test("refuses once the run's user lost log:admin", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeCustomRole,
    makeScheduleTrigger,
    makeScheduleTriggerRun,
  }) => {
    const { context, triggerId, organizationId } = await tunerRun({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      makeScheduleTrigger,
      makeScheduleTriggerRun,
    });
    const demoted = await makeUser();
    const role = await makeCustomRole(organizationId, {
      permission: { tuner: ["update"] },
    });
    await makeMember(demoted.id, organizationId, { role: role.role });
    await ScheduleTriggerModel.update(triggerId, { actorUserId: demoted.id });

    expect((await propose(context, CANDIDATE.fingerprint)).isError).toBe(true);
    const filed = await TunerSuggestionModel.list({
      organizationId,
      pagination: { limit: 10, offset: 0 },
    });
    expect(filed.data).toEqual([]);
  });

  test("does not exist outside a tuner run, or with tuners off", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeScheduleTrigger,
    makeScheduleTriggerRun,
  }) => {
    const { context } = await tunerRun({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      makeScheduleTrigger,
      makeScheduleTriggerRun,
    });

    await expect(
      propose(
        { ...context, scheduleTriggerRunId: undefined },
        CANDIDATE.fingerprint,
      ),
    ).rejects.toMatchObject({ code: -32601 });
    config.tuners.enabled = false;
    await expect(propose(context, CANDIDATE.fingerprint)).rejects.toMatchObject(
      { code: -32601 },
    );
  });
});

describe("tools inside a tuner run", () => {
  const saved = config.tuners.enabled;
  beforeEach(() => {
    config.tuners.enabled = true;
  });
  afterEach(() => {
    config.tuners.enabled = saved;
  });

  test("refuses delegation, asking people, discovery and unassigned tools, even when assigned", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeScheduleTrigger,
    makeScheduleTriggerRun,
    seedAndAssignArchestraTools,
  }) => {
    const { context } = await tunerRun({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      makeScheduleTrigger,
      makeScheduleTriggerRun,
    });
    await seedAndAssignArchestraTools(context.agent.id);

    for (const shortName of [
      "ask_user",
      "search_tools",
      "run_tool",
      "start_agent_run",
    ] as const) {
      const result = await executeArchestraTool(
        getArchestraToolFullName(shortName),
        {},
        context,
      );
      expect({ shortName, isError: result.isError }).toEqual({
        shortName,
        isError: true,
      });
    }
    for (const delegated of [
      `${AGENT_TOOL_PREFIX}helper`,
      `${SKILL_TOOL_PREFIX}helper`,
    ]) {
      const result = await executeArchestraTool(delegated, {}, context);
      expect({ delegated, isError: result.isError }).toEqual({
        delegated,
        isError: true,
      });
    }
  });

  test("leaves calls outside tuner runs alone", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeScheduleTrigger,
    makeScheduleTriggerRun,
    seedAndAssignArchestraTools,
  }) => {
    const { context } = await tunerRun({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      makeScheduleTrigger,
      makeScheduleTriggerRun,
    });
    await seedAndAssignArchestraTools(context.agent.id);

    const result = await executeArchestraTool(
      getArchestraToolFullName("get_guardrails_policy"),
      {},
      { ...context, scheduleTriggerRunId: undefined },
    );

    expect(result.isError).toBeFalsy();
  });

  test("allows an assigned read tool and refuses it once unassigned", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeScheduleTrigger,
    makeScheduleTriggerRun,
    seedAndAssignArchestraTools,
  }) => {
    const fixtures = {
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      makeScheduleTrigger,
      makeScheduleTriggerRun,
    };
    const assigned = await tunerRun(fixtures);
    await seedAndAssignArchestraTools(assigned.context.agent.id);
    const bare = await tunerRun(fixtures);
    const tool = getArchestraToolFullName("get_guardrails_policy");

    expect(
      (await executeArchestraTool(tool, {}, assigned.context)).isError,
    ).toBeFalsy();
    expect((await executeArchestraTool(tool, {}, bare.context)).isError).toBe(
      true,
    );
  });

  test("refuses an assigned tool once the run's user lost tuner rights", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeCustomRole,
    makeScheduleTrigger,
    makeScheduleTriggerRun,
    seedAndAssignArchestraTools,
  }) => {
    const { context, triggerId, organizationId } = await tunerRun({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      makeScheduleTrigger,
      makeScheduleTriggerRun,
    });
    await seedAndAssignArchestraTools(context.agent.id);
    const tool = getArchestraToolFullName("get_guardrails_policy");
    expect((await executeArchestraTool(tool, {}, context)).isError).toBeFalsy();

    const demoted = await makeUser();
    const role = await makeCustomRole(organizationId, {
      permission: { tuner: ["update"] },
    });
    await makeMember(demoted.id, organizationId, { role: role.role });
    await ScheduleTriggerModel.update(triggerId, { actorUserId: demoted.id });

    expect((await executeArchestraTool(tool, {}, context)).isError).toBe(true);
  });

  test("lists the remedy pair a governed session must declare, unassigned", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeScheduleTrigger,
    makeScheduleTriggerRun,
  }) => {
    const { context } = await tunerRun({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      makeScheduleTrigger,
      makeScheduleTriggerRun,
    });
    const allowed = await tunerRunToolFilter(context.agent.id);

    expect(
      (["execute_remedy_plan", "get_remedy_plans", "ask_user"] as const).map(
        (name) => allowed(getArchestraToolFullName(name)),
      ),
    ).toEqual([true, true, false]);
  });
});

async function tunerRun(
  params: Pick<
    TestFixtures,
    | "makeOrganization"
    | "makeUser"
    | "makeMember"
    | "makeAgent"
    | "makeScheduleTrigger"
    | "makeScheduleTriggerRun"
  >,
): Promise<{
  context: ArchestraContext;
  runId: string;
  triggerId: string;
  organizationId: string;
}> {
  const organization = await params.makeOrganization();
  const actor = await params.makeUser();
  await params.makeMember(actor.id, organization.id, {
    role: ADMIN_ROLE_NAME,
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
  await ScheduleTriggerRunModel.claimTunerScan({
    runId: run.id,
    record: { outcome: "agent_ran", candidates: [CANDIDATE] },
  });
  return {
    runId: run.id,
    triggerId: trigger.id,
    organizationId: organization.id,
    context: {
      agent: { id: agent.id, name: agent.name },
      agentId: agent.id,
      organizationId: organization.id,
      userId: actor.id,
      scheduleTriggerRunId: run.id,
    },
  };
}

function propose(context: ArchestraContext, fingerprint: string) {
  return executeArchestraTool(
    PROPOSE,
    { fingerprint, rationale: "It keeps happening." },
    context,
  );
}

import {
  ADMIN_ROLE_NAME,
  EDITOR_ROLE_NAME,
  MEMBER_ROLE_NAME,
} from "@archestra/shared";
import config from "@/config";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import TunerSuggestionModel from "@/models/tuner-suggestion";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type TestFixtures,
  test,
} from "@/test";
import {
  authenticatedRouteApp,
  USER_HEADER,
} from "@/test/authenticated-route-app";
import { type TunerKind, tunerFingerprint } from "@/types/tuner";
import type { TunerSuggestion } from "@/types/tuner-suggestion";
import tunerRoutes from "./tuner.routes";

describe("GET /api/tuner-suggestions", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let adminId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    config.tuners.enabled = true;
    organizationId = (await makeOrganization()).id;
    adminId = (await makeUser()).id;
    await makeMember(adminId, organizationId, { role: ADMIN_ROLE_NAME });
    app = await authenticatedRouteApp({
      organizationId,
      routes: [tunerRoutes],
    });
  });

  afterEach(async () => {
    await app.close();
  });

  const list = (query = "", userId = adminId) =>
    app.inject({
      method: "GET",
      url: `/api/tuner-suggestions${query}`,
      headers: { [USER_HEADER]: userId },
    });
  const ids = (response: Awaited<ReturnType<typeof list>>) =>
    response
      .json()
      .data.map((suggestion: TunerSuggestion) => suggestion.id)
      .sort();

  test("lists only this organization's suggestions, filtered by kind and status", async ({
    makeOrganization,
    makeUser,
    makeScheduleTrigger,
    makeScheduleTriggerRun,
  }) => {
    const fixtures = { makeScheduleTrigger, makeScheduleTriggerRun };
    const propose = await suggestionFactory(fixtures, organizationId, adminId);
    const sreOpen = await propose("sre", "api");
    const sreDone = await propose("sre", "worker");
    const appaOpen = await propose("appa", "mail");
    await TunerSuggestionModel.close({
      id: sreDone.id,
      organizationId,
      userId: adminId,
      status: "done",
      comment: null,
    });
    const otherOrganization = await makeOrganization();
    const otherAdmin = await makeUser();
    const otherPropose = await suggestionFactory(
      fixtures,
      otherOrganization.id,
      otherAdmin.id,
    );
    await otherPropose("sre", "api");

    const all = await list();
    expect(all.statusCode, all.body).toBe(200);
    expect(ids(all)).toEqual([sreOpen.id, sreDone.id, appaOpen.id].sort());
    expect(ids(await list("?kind=sre"))).toEqual(
      [sreOpen.id, sreDone.id].sort(),
    );
    expect(ids(await list("?status=open"))).toEqual(
      [sreOpen.id, appaOpen.id].sort(),
    );
    expect(ids(await list("?kind=sre&status=open"))).toEqual([sreOpen.id]);
    expect(ids(await list("?status=done&status=rejected"))).toEqual([
      sreDone.id,
    ]);
  });

  test("pages through the suggestions", async ({
    makeScheduleTrigger,
    makeScheduleTriggerRun,
  }) => {
    const propose = await suggestionFactory(
      { makeScheduleTrigger, makeScheduleTriggerRun },
      organizationId,
      adminId,
    );
    const created = [
      await propose("sre", "a"),
      await propose("sre", "b"),
      await propose("sre", "c"),
    ];

    const first = await list("?limit=2&offset=0");
    const second = await list("?limit=2&offset=2");

    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().pagination).toMatchObject({ total: 3, hasNext: true });
    expect(second.json().pagination).toMatchObject({
      total: 3,
      hasNext: false,
    });
    expect(ids(first)).toHaveLength(2);
    expect([...ids(first), ...ids(second)].sort()).toEqual(
      created.map((suggestion) => suggestion.id).sort(),
    );
  });

  test("is not found while tuners are disabled", async () => {
    config.tuners.enabled = false;
    expect((await list()).statusCode).toBe(404);
  });

  test("refuses members and roles missing tuner:read or log:admin", async ({
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    const userWithRole = async (role: string) => {
      const user = await makeUser();
      await makeMember(user.id, organizationId, { role });
      return user.id;
    };
    const customRole = async (permission: Record<string, string[]>) =>
      (await makeCustomRole(organizationId, { permission })).role;

    const denied = [
      await userWithRole(MEMBER_ROLE_NAME),
      await userWithRole(EDITOR_ROLE_NAME),
      await userWithRole(await customRole({ tuner: ["read", "update"] })),
      await userWithRole(await customRole({ log: ["read", "admin"] })),
    ];
    for (const userId of denied) {
      expect((await list("", userId)).statusCode).toBe(403);
    }
    const viewer = await userWithRole(
      await customRole({ tuner: ["read"], log: ["read", "admin"] }),
    );
    expect((await list("", viewer)).statusCode).toBe(200);
  });
});

async function suggestionFactory(
  fixtures: Pick<
    TestFixtures,
    "makeScheduleTrigger" | "makeScheduleTriggerRun"
  >,
  organizationId: string,
  actorUserId: string,
) {
  const trigger = await fixtures.makeScheduleTrigger({
    organizationId,
    actorUserId,
  });
  const run = await fixtures.makeScheduleTriggerRun(trigger.id);
  return async (tunerKind: TunerKind, name: string) => {
    const result = await TunerSuggestionModel.propose({
      organizationId,
      tunerKind,
      candidate: {
        fingerprint: tunerFingerprint(
          "sre_restart_loop",
          "default",
          "Deployment",
          name,
        ),
        source: "sre_restart_loop",
        severity: "warn",
        title: `${name} restarts`,
        detail: "6 restarts",
        evidence: [],
      },
      rationale: "why",
      action: { type: "note" },
      scheduleTriggerRunId: run.id,
      now: new Date(),
    });
    if (result.type !== "created") throw new Error("expected a suggestion");
    return result.suggestion;
  };
}
